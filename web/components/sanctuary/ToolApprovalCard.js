import {
  approveToolCall,
  fetchSessionToolCalls,
} from '../../queries/sanctuary.js';
import { renderLiveToolLogs } from './MessageRow.js';

/**
 * Inline Human-in-the-Loop approval card mounted inside the live Program thread
 * whenever a mutation or shell tool awaits explicit confirmation.
 */
export function createToolApprovalCard({
  callId,
  toolName,
  details,
  onResolved,
} = {}) {
  const doc = globalThis.document;
  const card = doc.createElement('div');
  card.className = 'tool-approval-card';
  card.dataset.callId = String(callId || '');
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', `Tool approval required for ${toolName || 'tool'}`);

  const header = doc.createElement('div');
  header.className = 'tool-approval-header';

  const badge = doc.createElement('span');
  badge.className = 'tool-approval-badge';
  badge.textContent = 'Approval Required';

  const nameEl = doc.createElement('strong');
  nameEl.className = 'tool-approval-name';
  nameEl.textContent = String(toolName || 'tool');

  header.appendChild(badge);
  header.appendChild(nameEl);
  card.appendChild(header);

  const pre = doc.createElement('pre');
  pre.className = 'tool-approval-details';
  pre.textContent = typeof details === 'string' ? details : JSON.stringify(details || {}, null, 2);
  card.appendChild(pre);

  const actions = doc.createElement('div');
  actions.className = 'tool-approval-actions';

  const denyBtn = doc.createElement('button');
  denyBtn.type = 'button';
  denyBtn.className = 'edit-btn edit-cancel-btn tool-deny-btn';
  denyBtn.textContent = 'Deny';

  const approveBtn = doc.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'edit-btn edit-save-btn tool-approve-btn';
  approveBtn.textContent = 'Approve';

  const submitDecision = async (status) => {
    denyBtn.disabled = true;
    approveBtn.disabled = true;
    try {
      await approveToolCall(callId, status);
      card.remove();
      onResolved?.(status, callId);
    } catch (err) {
      denyBtn.disabled = false;
      approveBtn.disabled = false;
      const errEl = card.querySelector('.tool-approval-error') || doc.createElement('p');
      errEl.className = 'tool-approval-error';
      errEl.textContent = err?.message || 'Approval request failed';
      card.appendChild(errEl);
    }
  };

  denyBtn.addEventListener('click', () => void submitDecision('denied'));
  approveBtn.addEventListener('click', () => void submitDecision('approved'));

  actions.appendChild(denyBtn);
  actions.appendChild(approveBtn);
  card.appendChild(actions);

  return card;
}

function updateLiveToolLogs(typingBubble, toolCalls = []) {
  renderLiveToolLogs(typingBubble, toolCalls);
}

/**
 * Poll /api/session_tool_calls while a Program turn is generating, surfacing live tool progress
 * and inline Human-in-the-Loop Approve/Deny cards without blocking social tabs.
 */
export function startTurnToolMonitor({
  sessionId = 'default',
  chatContainer,
  typingBubble = null,
  onApprovedMutation,
  intervalMs = 450,
} = {}) {
  let stopped = false;
  let timer = null;
  let activeCardCallId = null;
  let inFlight = false;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
    timer?.unref?.();
  };

  const tick = async () => {
    if (stopped || inFlight || activeCardCallId) return;
    inFlight = true;
    try {
      const data = await fetchSessionToolCalls(sessionId);
      if (stopped) return;
      if (Array.isArray(data?.tool_calls) && typingBubble) {
        updateLiveToolLogs(typingBubble, data.tool_calls);
      }
      if (data?.call_id && chatContainer) {
        activeCardCallId = data.call_id;
        const card = createToolApprovalCard({
          callId: data.call_id,
          toolName: data.tool_name,
          details: data.details,
          onResolved(status) {
            if (status === 'approved') onApprovedMutation?.();
            activeCardCallId = null;
            scheduleNext();
          },
        });
        const anchor = chatContainer.querySelector('#bottom-sentinel');
        chatContainer.insertBefore(card, anchor || null);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        return;
      }
    } catch {
      // Transient poll errors resolve on next tick or turn completion.
    } finally {
      inFlight = false;
      if (!stopped && !activeCardCallId) {
        scheduleNext();
      }
    }
  };

  void tick();

  return function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    chatContainer?.querySelectorAll?.('.tool-approval-card').forEach((el) => el.remove());
  };
}

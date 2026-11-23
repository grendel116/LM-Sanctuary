import {
  approveToolCall,
  fetchSessionToolCalls,
  submitBrowserCommandResult,
} from '../../queries/sanctuary.js';
import { renderLiveToolLogs } from './MessageRow.js';

/**
 * Inline Human-in-the-Loop approval card mounted inside the live Program thread
 * whenever a mutation or shell tool awaits explicit confirmation.
 */
export function createToolApprovalCard({
  callId,
  kind = 'approval',
  toolName,
  details,
  options = [],
  onResolved,
} = {}) {
  const doc = globalThis.document;
  const choiceOptions = Array.isArray(options)
    ? options.map((o) => String(o || '').trim()).filter(Boolean)
    : [];
  const isChoice = kind === 'choice' || choiceOptions.length > 0;

  const card = doc.createElement('div');
  card.className = `tool-approval-card${isChoice ? ' tool-choice-card' : ''}`;
  card.dataset.callId = String(callId || '');
  card.setAttribute('role', 'region');
  card.setAttribute(
    'aria-label',
    isChoice
      ? `Decision requested for ${toolName || 'agent'}`
      : `Tool approval required for ${toolName || 'tool'}`
  );

  const header = doc.createElement('div');
  header.className = 'tool-approval-header';

  const badge = doc.createElement('span');
  badge.className = 'tool-approval-badge';
  badge.textContent = isChoice ? 'Decision Requested' : 'Approval Required';

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

  const interactiveControls = [];
  const setDisabledAll = (disabled) => {
    for (const el of interactiveControls) {
      el.disabled = disabled;
    }
  };

  const submitDecision = async (status, extra = {}) => {
    setDisabledAll(true);
    try {
      await approveToolCall(callId, status, extra);
      card.remove();
      onResolved?.(status, callId, extra);
    } catch (err) {
      setDisabledAll(false);
      const errEl = card.querySelector('.tool-approval-error') || doc.createElement('p');
      errEl.className = 'tool-approval-error';
      errEl.textContent = err?.message || 'Approval request failed';
      card.appendChild(errEl);
    }
  };

  if (isChoice) {
    if (choiceOptions.length > 0) {
      const optList = doc.createElement('div');
      optList.className = 'tool-choice-options';
      optList.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px;';
      choiceOptions.forEach((optLabel, idx) => {
        const optBtn = doc.createElement('button');
        optBtn.type = 'button';
        optBtn.className = 'edit-btn tool-choice-option-btn';
        optBtn.style.textAlign = 'left';
        optBtn.textContent = optLabel;
        optBtn.addEventListener('click', () =>
          void submitDecision('approved', { optionIndex: idx, answerText: optLabel })
        );
        interactiveControls.push(optBtn);
        optList.appendChild(optBtn);
      });
      card.appendChild(optList);
    }

    const customRow = doc.createElement('div');
    customRow.className = 'tool-approval-actions tool-choice-custom-row';
    customRow.style.gap = '6px';

    const customInput = doc.createElement('input');
    customInput.type = 'text';
    customInput.className = 'onboarding-input tool-choice-input';
    customInput.placeholder = choiceOptions.length > 0 ? 'Or type a custom answer...' : 'Type your answer...';
    customInput.setAttribute('aria-label', 'Custom decision response');
    customInput.style.flex = '1';

    const sendCustomBtn = doc.createElement('button');
    sendCustomBtn.type = 'button';
    sendCustomBtn.className = 'edit-btn edit-save-btn tool-approve-btn';
    sendCustomBtn.textContent = 'Reply';
    sendCustomBtn.addEventListener('click', () => {
      const val = customInput.value.trim();
      if (!val && choiceOptions.length > 0) {
        void submitDecision('approved', { optionIndex: 0, answerText: choiceOptions[0] });
        return;
      }
      void submitDecision('approved', { answerText: val });
    });

    const skipBtn = doc.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'edit-btn edit-cancel-btn tool-deny-btn';
    skipBtn.textContent = 'Dismiss';
    skipBtn.addEventListener('click', () => void submitDecision('denied'));

    interactiveControls.push(customInput, sendCustomBtn, skipBtn);
    customRow.append(skipBtn, customInput, sendCustomBtn);
    card.appendChild(customRow);
    return card;
  }

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

  interactiveControls.push(denyBtn, approveBtn);
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
  onClientAction,
  onBrowserCommand,
  intervalMs = 450,
} = {}) {
  let stopped = false;
  let timer = null;
  let activeCardCallId = null;
  let inFlight = false;
  const dispatchedActionIds = new Set();
  const dispatchedBrowserCmdIds = new Set();

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
    timer?.unref?.();
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const data = await fetchSessionToolCalls(sessionId);
      if (stopped) return;
      if (Array.isArray(data?.tool_calls)) {
        if (typingBubble) {
          updateLiveToolLogs(typingBubble, data.tool_calls);
        }
        if (typeof onClientAction === 'function') {
          for (const tc of data.tool_calls) {
            const action = tc?.client_action;
            const actionKey = tc?.id || (action ? `${action.type}:${action.url}:${Boolean(action.split)}` : '');
            if (action && actionKey && !dispatchedActionIds.has(actionKey)) {
              dispatchedActionIds.add(actionKey);
              onClientAction(action, tc);
            }
          }
        }
      }
      if (data?.browser_command?.cmd_id && typeof onBrowserCommand === 'function') {
        const bcmd = data.browser_command;
        if (!dispatchedBrowserCmdIds.has(bcmd.cmd_id)) {
          dispatchedBrowserCmdIds.add(bcmd.cmd_id);
          let cmdResult;
          try {
            cmdResult = await onBrowserCommand(bcmd);
          } catch (err) {
            cmdResult = { ok: false, error: 'client_error', message: err?.message || 'Browser command failed' };
          }
          await submitBrowserCommandResult(bcmd.cmd_id, cmdResult).catch(() => {});
        }
      }
      if (data?.call_id && chatContainer) {
        if (data.call_id !== activeCardCallId) {
          chatContainer.querySelectorAll?.('.tool-approval-card').forEach((el) => el.remove());
          activeCardCallId = data.call_id;
          const card = createToolApprovalCard({
            callId: data.call_id,
            kind: data.kind || 'approval',
            toolName: data.tool_name,
            details: data.details,
            options: data.options || [],
            onResolved(status) {
              if (status === 'approved') onApprovedMutation?.();
              activeCardCallId = null;
            },
          });
          const anchor = chatContainer.querySelector('#bottom-sentinel');
          chatContainer.insertBefore(card, anchor || null);
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
      } else if (!data?.call_id && activeCardCallId) {
        activeCardCallId = null;
        chatContainer?.querySelectorAll?.('.tool-approval-card').forEach((el) => el.remove());
      }
    } catch {
      // Transient poll errors resolve on next tick or turn completion.
    } finally {
      inFlight = false;
      if (!stopped) {
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

import {
  completeQuest,
  deleteQuest,
  fetchQuests,
} from '../../queries/sanctuary.js';
import {
  createClassicModalDialog,
  downloadNodeFile,
  showAlert,
  showConfirm,
} from './SanctuaryDialog.js';

const QUEST_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>`;
const TRASH_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
const CHECK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const CAL_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;
const ICS_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

function buildGoogleCalendarUrl(quest) {
  let startDate = new Date();
  let extraNote = '';
  if (quest.due) {
    const parsed = new Date(quest.due);
    if (!Number.isNaN(parsed.getTime())) {
      startDate = parsed;
    } else {
      extraNote = `\n\n(Target time: ${quest.due})`;
    }
  }
  const startStr = `${startDate.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  const endStr = `${endDate.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  const title = encodeURIComponent(quest.title || 'Quest');
  const details = encodeURIComponent(`${(quest.objectives || []).join('\n')}${extraNote}`);
  const loc = encodeURIComponent(quest.location || '');
  return `https://calendar.google.com/calendar/r/eventedit?action=TEMPLATE&text=${title}&dates=${startStr}/${endStr}&details=${details}&location=${loc}`;
}

/**
 * Classic Quest Log modal with Google Calendar link, VALARM .ics export, Complete, and Delete actions.
 */
export function openQuestModal({ sessionId = 'default', onQuestCompleted } = {}) {
  const doc = globalThis.document;
  let closed = false;

  const modal = createClassicModalDialog({
    id: 'quest-log-dialog',
    maxWidth: '580px',
    onClose: () => {
      closed = true;
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${QUEST_SVG}<span>Quest Log</span>`;

  const listEl = doc.createElement('div');
  listEl.className = 'classic-modal-scroll-body classic-cards-stack';

  modal.card.append(heading, listEl);

  async function refresh() {
    try {
      const data = await fetchQuests();
      if (closed) return;
      const quests = data?.quests || [];
      if (quests.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No active quests. Ask your program to assign you one!';
        listEl.replaceChildren(empty);
        return;
      }

      listEl.replaceChildren(
        ...quests.map((q) => {
          const card = doc.createElement('div');
          card.className = 'list-entry-row';

          const top = doc.createElement('div');
          top.className = 'list-entry-header';

          const qTitle = doc.createElement('h4');
          qTitle.style.margin = '0';
          qTitle.style.color = '#fbbf24';
          qTitle.textContent = q.title || 'Quest';

          const acts = doc.createElement('div');
          acts.className = 'classic-card-actions';

          const delBtn = doc.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'edit-btn edit-cancel-btn';
          delBtn.title = 'Delete Quest';
          delBtn.setAttribute('aria-label', `Delete ${q.title || 'quest'}`);
          delBtn.innerHTML = TRASH_SVG;
          delBtn.addEventListener('click', () => {
            showConfirm(
              'Delete Quest',
              'Permanently delete this quest? Your program will not be notified.',
              async () => {
                await deleteQuest(q.id);
                await refresh();
              }
            );
          });

          const doneBtn = doc.createElement('button');
          doneBtn.type = 'button';
          doneBtn.className = 'edit-btn edit-save-btn';
          doneBtn.title = 'Complete Quest';
          doneBtn.setAttribute('aria-label', `Complete ${q.title || 'quest'}`);
          doneBtn.innerHTML = CHECK_SVG;
          doneBtn.addEventListener('click', async () => {
            try {
              await completeQuest(q.id, sessionId);
              await onQuestCompleted?.(q);
              await refresh();
            } catch (err) {
              showAlert('Error', `Error completing quest: ${err?.message || 'unknown error'}`);
            }
          });

          acts.append(delBtn, doneBtn);
          top.append(qTitle, acts);
          card.appendChild(top);

          if (q.location) {
            const locEl = doc.createElement('div');
            locEl.className = 'classic-card-subtext';
            locEl.textContent = `Location: ${q.location}`;
            card.appendChild(locEl);
          }

          const parsedDue = q.due ? new Date(q.due) : null;
          const dueLabel = parsedDue && !Number.isNaN(parsedDue.getTime())
            ? parsedDue.toLocaleString()
            : (q.due || 'No Target Time');
          const dueEl = doc.createElement('div');
          dueEl.className = 'classic-card-subtext';
          dueEl.textContent = `Target: ${dueLabel}`;
          card.appendChild(dueEl);

          if (Array.isArray(q.objectives) && q.objectives.length > 0) {
            const ul = doc.createElement('ul');
            ul.className = 'classic-quest-objectives';
            for (const obj of q.objectives) {
              const li = doc.createElement('li');
              li.textContent = obj;
              ul.appendChild(li);
            }
            card.appendChild(ul);
          }

          const calFooter = doc.createElement('div');
          calFooter.className = 'classic-card-actions';
          calFooter.style.marginTop = '6px';

          const gcalLink = doc.createElement('a');
          gcalLink.href = buildGoogleCalendarUrl(q);
          gcalLink.target = '_blank';
          gcalLink.rel = 'noopener noreferrer';
          gcalLink.className = 'edit-btn edit-save-btn';
          gcalLink.style.textDecoration = 'none';
          gcalLink.innerHTML = `${CAL_SVG}<span>Add to Google</span>`;

          const icsBtn = doc.createElement('button');
          icsBtn.type = 'button';
          icsBtn.className = 'edit-btn edit-cancel-btn';
          icsBtn.innerHTML = `${ICS_SVG}<span>Download ICS</span>`;
          icsBtn.addEventListener('click', () => {
            void downloadNodeFile(`/api/quests/${encodeURIComponent(q.id)}/download`, `${q.id}.ics`);
          });

          calFooter.append(gcalLink, icsBtn);
          card.appendChild(calFooter);
          return card;
        })
      );
    } catch (err) {
      if (closed) return;
      const errDiv = doc.createElement('div');
      errDiv.className = 'empty-state';
      errDiv.textContent = err?.message || 'Failed to load quests.';
      listEl.replaceChildren(errDiv);
    }
  }

  modal.open();
  void refresh();
  return modal;
}

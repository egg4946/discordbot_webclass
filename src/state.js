import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_STATE = {
  assignments: [],
  notified: {},
  updatedAt: null,
};

const DEADLINE_THRESHOLD_HOURS = 24;
const TOKYO_TIME_ZONE = 'Asia/Tokyo';

export async function loadState(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ...DEFAULT_STATE, isFirstRun: true };
    }
    throw error;
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

export function buildNotifications(previousState, currentAssignments, now = new Date()) {
  const previousByStableKey = new Map(
    previousState.assignments.map((item) => [item.stableKey, item]),
  );
  const previousBySourceId = new Map(
    previousState.assignments
      .map((item) => [assignmentSourceId(item), item])
      .filter(([sourceId]) => sourceId),
  );
  const notifications = [];
  const notified = { ...previousState.notified };

  for (const assignment of currentAssignments) {
    const previous =
      previousByStableKey.get(assignment.stableKey) ||
      previousBySourceId.get(assignmentSourceId(assignment));
    const deadline = parseDeadline(assignment.deadlineAt);
    if (!deadline) {
      continue;
    }

    const reminderKeys = buildReminderKeys(assignment, deadline);
    const hoursLeft = (deadline.getTime() - now.getTime()) / 1000 / 60 / 60;
    const isDueToday = isSameTokyoDate(now, deadline);
    const isWithin24Hours = hoursLeft > 0 && hoursLeft <= DEADLINE_THRESHOLD_HOURS;

    if (!previousState.isFirstRun && !previous) {
      notifications.push({ type: 'newAssignment', assignment });

      // A new-assignment notification replaces reminders that are already due.
      if (isWithin24Hours) {
        notified[reminderKeys.deadline24] = now.toISOString();
      }
      if (isDueToday && isUnsubmitted(assignment)) {
        notified[reminderKeys.dueToday] = now.toISOString();
      }
      continue;
    }

    if (
      previous &&
      previous.deadlineAt &&
      previous.deadlineAt !== assignment.deadlineAt
    ) {
      notifications.push({
        type: 'deadlineChanged',
        assignment,
        previousDeadlineText: previous.deadlineText || '不明',
      });
    }

    if (
      hoursLeft > 0 &&
      isDueToday &&
      isUnsubmitted(assignment) &&
      !notified[reminderKeys.dueToday]
    ) {
      notifications.push({ type: 'dueTodayUnsubmitted', assignment });
      notified[reminderKeys.dueToday] = now.toISOString();
    }

    if (isWithin24Hours && !notified[reminderKeys.deadline24]) {
      notifications.push({
        type: 'deadlineSoon',
        assignment,
        threshold: DEADLINE_THRESHOLD_HOURS,
      });
      notified[reminderKeys.deadline24] = now.toISOString();
    }
  }

  return { notifications, notified, firstRun: Boolean(previousState.isFirstRun) };
}

function buildReminderKeys(assignment, deadline) {
  const deadlineKey = deadline.toISOString();
  return {
    deadline24: `${assignment.stableKey}:${deadlineKey}:deadline24`,
    dueToday: `${assignment.stableKey}:${deadlineKey}:dueToday`,
  };
}

function parseDeadline(value) {
  if (!value) {
    return null;
  }
  const deadline = new Date(value);
  return Number.isNaN(deadline.getTime()) ? null : deadline;
}

function isUnsubmitted(assignment) {
  return /^(未提出|未受験)$/.test(assignment.status ?? '');
}

function assignmentSourceId(assignment) {
  if (assignment.sourceId) {
    return assignment.sourceId;
  }

  try {
    const url = new URL(assignment.url);
    return (
      url.searchParams.get('set_contents_id') ||
      url.pathname.match(/\/contents\/([^/]+)/)?.[1] ||
      null
    );
  } catch {
    return null;
  }
}

function isSameTokyoDate(left, right) {
  return formatTokyoDate(left) === formatTokyoDate(right);
}

function formatTokyoDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TOKYO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

import { readFile } from 'node:fs/promises';
import { writeJsonFile } from './json-file.js';

export const STATE_PATH = 'data/state.json';

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
  await writeJsonFile(path, { ...state, updatedAt: new Date().toISOString() });
}

// Assignments saved by the last check whose deadline has not passed yet.
export function activeAssignments(assignments, now = new Date()) {
  return assignments.filter((assignment) => {
    const deadline = parseDeadline(assignment.deadlineAt);
    return deadline && deadline > now;
  });
}

export function buildNotifications(previousState, currentAssignments, now = new Date()) {
  const previousByStableKey = new Map();
  const previousBySourceId = new Map();
  for (const item of previousState.assignments) {
    const sourceId = assignmentSourceId(item);
    if (sourceId) {
      previousBySourceId.set(sourceId, item);
    } else {
      previousByStableKey.set(item.stableKey, item);
    }
  }
  const notifications = [];
  const notified = { ...previousState.notified };

  for (const assignment of currentAssignments) {
    // Same-title contents are distinct, so stableKey is only a fallback for entries without an ID.
    const sourceId = assignmentSourceId(assignment);
    const previous =
      (sourceId && previousBySourceId.get(sourceId)) ||
      previousByStableKey.get(assignment.stableKey);
    const deadline = parseDeadline(assignment.deadlineAt);
    if (!deadline) {
      continue;
    }

    const reminderKeys = buildReminderKeys(assignment, previous, deadline);
    const isNotified = (keys) => keys.some((key) => notified[key]);
    const hoursLeft = (deadline.getTime() - now.getTime()) / 1000 / 60 / 60;
    const isDueToday = isSameTokyoDate(now, deadline);
    const isWithin24Hours = hoursLeft > 0 && hoursLeft <= DEADLINE_THRESHOLD_HOURS;

    // Each notification carries the reminder keys it marks as sent, so a caller that
    // fails midway can record only the notifications that were actually delivered.
    const mark = (keys) => ({ [keys[0]]: now.toISOString() });

    if (!previousState.isFirstRun && !previous) {
      // A new-assignment notification replaces reminders that are already due.
      const notifiedMarks = {
        ...(isWithin24Hours ? mark(reminderKeys.deadline24) : {}),
        ...(isDueToday && isUnsubmitted(assignment) ? mark(reminderKeys.dueToday) : {}),
      };
      notifications.push({ type: 'newAssignment', assignment, notifiedMarks });
      Object.assign(notified, notifiedMarks);
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
        previousAssignment: previous,
        previousDeadlineText: previous.deadlineText || '不明',
        notifiedMarks: {},
      });
    }

    if (
      hoursLeft > 0 &&
      isDueToday &&
      isUnsubmitted(assignment) &&
      !isNotified(reminderKeys.dueToday)
    ) {
      const notifiedMarks = mark(reminderKeys.dueToday);
      notifications.push({ type: 'dueTodayUnsubmitted', assignment, notifiedMarks });
      Object.assign(notified, notifiedMarks);
    }

    if (isWithin24Hours && !isNotified(reminderKeys.deadline24)) {
      const notifiedMarks = mark(reminderKeys.deadline24);
      notifications.push({
        type: 'deadlineSoon',
        assignment,
        threshold: DEADLINE_THRESHOLD_HOURS,
        notifiedMarks,
      });
      Object.assign(notified, notifiedMarks);
    }
  }

  return { notifications, notified, firstRun: Boolean(previousState.isFirstRun) };
}

// Builds the state to save after the first `sentCount` notifications were delivered.
// Assignments whose new/changed notification was not delivered keep their previous
// form, so the next run detects them again instead of silently dropping the notice.
export function buildStateAfterSending(previousState, assignments, notifications, sentCount) {
  const notified = { ...previousState.notified };
  for (const notification of notifications.slice(0, sentCount)) {
    Object.assign(notified, notification.notifiedMarks);
  }

  const replacements = new Map();
  for (const notification of notifications.slice(sentCount)) {
    if (notification.type === 'newAssignment') {
      replacements.set(notification.assignment, null);
    } else if (notification.type === 'deadlineChanged') {
      replacements.set(notification.assignment, notification.previousAssignment);
    }
  }

  const savedAssignments = assignments
    .map((assignment) =>
      replacements.has(assignment) ? replacements.get(assignment) : assignment,
    )
    .filter(Boolean);

  return { assignments: savedAssignments, notified };
}

// When some course pages could not be read, keeps the previous assignments of courses
// that are missing from this fetch so they are not re-announced as new next time.
export function carryOverUnfetchedAssignments(previousAssignments, fetchedAssignments, now = new Date()) {
  const fetchedCourses = new Set(fetchedAssignments.map((item) => item.courseName));
  return previousAssignments.filter((item) => {
    const deadline = parseDeadline(item.deadlineAt);
    return !fetchedCourses.has(item.courseName) && deadline && deadline > now;
  });
}

// The first key of each list is written; the others are legacy stableKey-based keys
// that still count as already sent.
function buildReminderKeys(assignment, previous, deadline) {
  const sourceId = assignmentSourceId(assignment);
  const bases = [sourceId ? `source:${sourceId}` : assignment.stableKey];
  for (const legacyKey of [assignment.stableKey, previous?.stableKey]) {
    if (legacyKey && !bases.includes(legacyKey)) {
      bases.push(legacyKey);
    }
  }

  const deadlineKey = deadline.toISOString();
  return {
    deadline24: bases.map((base) => `${base}:${deadlineKey}:deadline24`),
    dueToday: bases.map((base) => `${base}:${deadlineKey}:dueToday`),
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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_STATE = {
  assignments: [],
  notified: {},
  updatedAt: null,
};

const DEADLINE_THRESHOLD_HOURS = 24;

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
  const previousById = new Map(previousState.assignments.map((item) => [item.id, item]));
  const notifications = [];
  const notified = { ...previousState.notified };

  for (const assignment of currentAssignments) {
    if (!previousState.isFirstRun && !previousById.has(assignment.id)) {
      notifications.push({ type: 'newAssignment', assignment });
    }

    const deadline = assignment.deadlineAt ? new Date(assignment.deadlineAt) : null;
    if (!deadline || Number.isNaN(deadline.getTime())) {
      continue;
    }

    const hoursLeft = (deadline.getTime() - now.getTime()) / 1000 / 60 / 60;
    const key = `${assignment.id}:deadline:${DEADLINE_THRESHOLD_HOURS}`;
    if (hoursLeft > 0 && hoursLeft <= DEADLINE_THRESHOLD_HOURS && !notified[key]) {
      notifications.push({
        type: 'deadlineSoon',
        assignment,
        threshold: DEADLINE_THRESHOLD_HOURS,
      });
      notified[key] = new Date().toISOString();
    }
  }

  return { notifications, notified, firstRun: Boolean(previousState.isFirstRun) };
}

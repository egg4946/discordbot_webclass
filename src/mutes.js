import { readFile } from 'node:fs/promises';
import { writeJsonFile } from './json-file.js';

export const MUTES_PATH = 'data/mutes.json';

// Discord limits autocomplete to 25 choices of at most 100 characters.
const MAX_CHOICES = 25;
const MAX_CHOICE_LENGTH = 100;

// Course names are compared loosely so full-width/half-width and spacing differences still match.
export function courseKey(courseName) {
  return (courseName ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export async function loadMutedCourses(path = MUTES_PATH) {
  try {
    const raw = await readFile(path, 'utf8');
    const courses = JSON.parse(raw).courses;
    return Array.isArray(courses) ? courses.filter((name) => typeof name === 'string') : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function saveMutedCourses(path, courses) {
  await writeJsonFile(path, { courses });
}

export function isMutedCourse(mutedCourses, courseName) {
  const key = courseKey(courseName);
  return Boolean(key) && mutedCourses.some((name) => courseKey(name) === key);
}

export function addMutedCourse(mutedCourses, courseName) {
  if (isMutedCourse(mutedCourses, courseName)) {
    return { courses: mutedCourses, changed: false };
  }
  return { courses: [...mutedCourses, courseName], changed: true };
}

export function removeMutedCourse(mutedCourses, courseName) {
  const key = courseKey(courseName);
  const courses = mutedCourses.filter((name) => courseKey(name) !== key);
  return { courses, changed: courses.length !== mutedCourses.length };
}

// Muted notifications are placed first and treated as already delivered, so the state
// records them as sent and unmuting later does not replay old notifications.
export function partitionMutedNotifications(notifications, mutedCourses) {
  const muted = [];
  const active = [];
  for (const notification of notifications) {
    if (isMutedCourse(mutedCourses, notification.assignment?.courseName)) {
      muted.push(notification);
    } else {
      active.push(notification);
    }
  }
  return { muted, active };
}

export function uniqueCourseNames(assignments) {
  const names = new Map();
  for (const { courseName } of assignments) {
    if (courseName && !names.has(courseKey(courseName))) {
      names.set(courseKey(courseName), courseName);
    }
  }
  return Array.from(names.values()).sort((left, right) => left.localeCompare(right, 'ja'));
}

export function courseChoices(courseNames, query) {
  const queryKey = courseKey(query);
  return courseNames
    .filter((name) => courseKey(name).includes(queryKey))
    .slice(0, MAX_CHOICES)
    .map((name) => {
      const value = name.slice(0, MAX_CHOICE_LENGTH);
      return { name: value, value };
    });
}

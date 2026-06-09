const MAX_DESCRIPTION_LENGTH = 3900;
const MAX_LINE_LENGTH = 900;

export function isUnsubmittedAssignment(assignment) {
  const text = `${assignment.status ?? ''} ${assignment.sourceText ?? ''}`;
  if (/(提出済|受験済)/.test(text)) {
    return false;
  }
  return /(未提出|未受験)/.test(text);
}

export function buildAssignmentListEmbeds(assignments, title, emptyMessage) {
  if (assignments.length === 0) {
    return [
      {
        title,
        description: emptyMessage,
        color: 0x6fcf97,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  const pages = chunkLines(assignments.map(formatAssignmentLine), MAX_DESCRIPTION_LENGTH);
  return pages.map((lines, index) => ({
    title: pages.length === 1 ? title : `${title} (${index + 1}/${pages.length})`,
    description: lines.join('\n'),
    color: 0x2f80ed,
    timestamp: new Date().toISOString(),
  }));
}

function formatAssignmentLine(assignment, index) {
  const title = escapeMarkdown(assignment.title || '無題の課題');
  const course = escapeMarkdown(assignment.courseName || '不明');
  const deadline = escapeMarkdown(assignment.deadlineText || '不明');
  return truncateLine(
    `**${index + 1}. ${title}**\n授業: ${course}\n提出期限: ${deadline}`,
  );
}

function chunkLines(lines, maxLength) {
  const pages = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const nextLength = currentLength + line.length + 1;
    if (current.length > 0 && nextLength > maxLength) {
      pages.push(current);
      current = [];
      currentLength = 0;
    }

    current.push(line);
    currentLength += line.length + 1;
  }

  if (current.length > 0) {
    pages.push(current);
  }

  return pages;
}

function escapeMarkdown(value) {
  return value.replace(/([*_`~|])/g, '\\$1');
}

function truncateLine(value) {
  if (value.length <= MAX_LINE_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_LINE_LENGTH - 20)}\n...省略しました`;
}

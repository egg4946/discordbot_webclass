const OWNER_ONLY_COMMANDS = new Set([
  'webclass-unsubmitted',
  'webclass-next',
]);

export function requiresOwner(commandName, includeSubmitted = true) {
  return (
    OWNER_ONLY_COMMANDS.has(commandName) ||
    (commandName === 'webclass-all' && includeSubmitted === false)
  );
}

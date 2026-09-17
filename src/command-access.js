const OWNER_ONLY_COMMANDS = new Set([
  'webclass-unsubmitted',
  'webclass-next',
  // Muting changes what the shared channel receives, so only the owner may do it.
  'webclass-mute',
  'webclass-unmute',
  'webclass-mutes',
]);

export function requiresOwner(commandName, includeSubmitted = true) {
  return (
    OWNER_ONLY_COMMANDS.has(commandName) ||
    (commandName === 'webclass-all' && includeSubmitted === false)
  );
}

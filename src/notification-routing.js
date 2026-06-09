export function notificationDestination(notification) {
  return notification.type === 'dueTodayUnsubmitted' ? 'ownerDm' : 'channel';
}

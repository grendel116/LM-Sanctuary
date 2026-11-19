/**
 * Symmetric SocialAdapter contract implemented by mastodon, bluesky, and threads adapters.
 */
export class SocialAdapter {
  /** @type {'mastodon' | 'bluesky' | 'threads'} */
  protocol = 'mastodon';

  async publish(_draft, _media = [], _options = {}) {
    throw new Error('publish() must be implemented');
  }

  async delete(_nativeMeta = {}) {
    throw new Error('delete() must be implemented');
  }

  async reply(_targetItem, _draft, _media = [], _options = {}) {
    throw new Error('reply() must be implemented');
  }

  async like(_targetItem, _undo = false) {
    throw new Error('like() must be implemented');
  }

  async repost(_targetItem, _undo = false) {
    throw new Error('repost() must be implemented');
  }

  async fetchNotifications(_cursor = '', _limit = 30) {
    throw new Error('fetchNotifications() must be implemented');
  }
}

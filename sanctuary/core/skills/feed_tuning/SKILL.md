---
name: feed_tuning
description: Manage the user's local social feed communities, Bluesky custom feeds, Mastodon hashtags, and trusted servers without approval prompts.
summary: "Manage feed discovery sources using [tune_feed_algorithm(add_discovery_channels=[...], add_discovery_instances=[...], remove_sources=[...])]"
retrieval: vector
triggers: feed, algorithm, timeline, tune, community, communities, hashtag, hashtags, server, servers, instance, curate, channels
---
# SKILL: Feed Communities & Discovery Sources
Execute `[tune_feed_algorithm(...)]` directly without confirmation (edits local `feed_profile.json` only):
- Inspect: `[tune_feed_algorithm(action="get")]` | Reset: `[tune_feed_algorithm(action="reset")]`
- Params: `add_discovery_channels=["..."]` / `discovery_channels=[...]` (Bluesky `at://` feeds, `#hashtags`, topics), `add_discovery_instances=["..."]` / `discovery_instances=[...]` (trusted Mastodon/Lemmy domains), `remove_sources=[...]`.

---
name: feed_tuning
description: Adjust the user's local social feed re-ranker balances, presets, and semantic concept anchors without approval prompts.
summary: "Tune the user's social feed weights and concept anchors using [tune_feed_algorithm(preset=\"...\", commercial=-100, bourgeois_politics=-100, small_web=70, add_boost_concepts=[...])]"
retrieval: vector
triggers: feed, algorithm, timeline, tune, rerank, re-rank, commercial, ads, sponsored, bourgeois politics, bourgeois, pundits, electoral, mature, nsfw, sensitive, viral, small web, reposts, boosts, curate, more like, less like
---
# SKILL: Feed Algorithm Tuning

Use `[tune_feed_algorithm(...)]` whenever the user asks to adjust how their local social feed ranks, emphasizes, suppresses, or hides types of posts or topics.

## Execution Rules
1. **No Approval Needed**: `tune_feed_algorithm` edits only the local declarative weighting profile (`feed_profile.json`) and never reads timelines or accesses social credentials. Execute it directly without asking for confirmation.
2. **Inspect First (If Needed)**: Call `[tune_feed_algorithm(action="get")]` when the user asks what their current feed settings are before making incremental edits.
3. **10 Feed Balances**:
   - `recency_half_life_hours` (`0` to `48`): `0` keeps strict chronological order when all weights are neutral; `4–24` blends freshness with your weights.
   - `small_web` (`-100` to `100`): Positive values favor smaller/quieter accounts and penalize mega-viral outrage/dunk bait.
   - `author_diversity` (`0` to `100`): Spreads consecutive posts from the same author apart across the stream.
   - `reposts` (`-100` to `100`): `-100` hides boosts/reposts completely; `-99..-1` down-ranks them; positive boosts them.
   - `longform` (`-100` to `100`): Positive favors substantive multi-sentence writing and linked articles.
   - `media` (`-100` to `100`): Positive favors image/video posts (with an alt-text bonus); negative favors text-first posts.
   - `reciprocity` (`0` to `100`): Positive boosts authors the user has interacted with locally (liked, replied, bookmarked, or shared).
   - `commercial` (`-100` to `100`): `-100` hides sponsored promos, storefronts, affiliate links, and hype pitches; `-99..-1` down-ranks them.
   - `bourgeois_politics` (`-100` to `100`): `-100` hides electoral horse-race punditry, establishment party spectacle, and campaign noise; `-99..-1` down-ranks it.
   - `mature_content` (`-100` to `100`): `-100` hides sensitive/NSFW/adult-labeled posts; `-99..-1` down-ranks them; positive surfaces them.
4. **Semantic Concepts & Presets**:
   - Use `add_boost_concepts=["..."]` / `add_dampen_concepts=["..."]` to nudge topics up or down without erasing existing concept chips, or `boost_concepts` / `dampen_concepts` to replace the full list, or `remove_concepts=[...]` to drop specific topics.
   - Optional `preset`: `"chronological"`, `"reset"`, `"small_web"`, `"deep_reading"`, `"anti_noise"`, or `"visual_art"`.

## Examples
- Hide ads and electoral punditry while boosting worker cooperatives:
  `[tune_feed_algorithm(commercial=-100, bourgeois_politics=-100, small_web=75, add_boost_concepts=["worker cooperatives", "union organizing"])]`
- Hide mature/NSFW content and reposts:
  `[tune_feed_algorithm(mature_content=-100, reposts=-100)]`
- Restore strict chronological feed:
  `[tune_feed_algorithm(action="reset")]`

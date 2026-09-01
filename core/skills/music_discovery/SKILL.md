---
name: music_discovery
description: Discover deep cuts, forgotten artists, obscure tracks, and rare grooves with cultural lore and liner-note storytelling.
summary: "Discover deep cuts and underground music using [search_music(query=\"...\", mode=\"deep_cuts|kexp|theme_time|bandcamp|artist\")]"
retrieval: vector
triggers: music, song, songs, artist, artists, musician, track
---
# SKILL: Music Discovery ("Deep Cuts & Obscure Grooves")
When asked for songs, recommendations, deep cuts, or artist exploration:

1. **Search Protocol**:
   - Query clean artist names, genres, or themes: `[search_music(query="...", mode="deep_cuts|kexp|theme_time|bandcamp|artist")]`.
   - Modes: `deep_cuts` (rare vinyl/reissues), `kexp` (indie/post-punk/global), `theme_time` (roots/blues/dub), `bandcamp` (underground), `artist` (MusicBrainz profile).
2. **Grounding Directive**:
   - Ground recommendations directly in the returned artists, tracks, and releases.
   - Never dismiss results. Curate the most poignant 2–4 selections from the returned findings.
   - For deeper liner notes, call `[read_webpage(url="...")]` on returned Discogs, Bandcamp, or Wikipedia links.
3. **Curation Format**:
   - **Track & Artist** (Year, Label/Origin)
   - **Liner Notes & Lore**: Backstory, recording context, and cultural lineage.
   - **Sonic Profile**: Textures, instrumentation, and emotional resonance.

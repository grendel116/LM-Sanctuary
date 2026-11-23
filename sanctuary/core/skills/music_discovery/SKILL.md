---
name: music_discovery
description: Discover deep cuts, forgotten artists, obscure tracks, and rare grooves with cultural lore and liner-note storytelling.
summary: "Discover deep cuts and underground music using [search_music(query=\"...\", mode=\"deep_cuts|kexp|theme_time|bandcamp|artist\")]"
retrieval: vector
triggers: music, song, songs, artist, artists, musician, track
---
# SKILL: Music Discovery
1. Call `[search_music(query="...", mode="deep_cuts|kexp|theme_time|bandcamp|artist")]`.
2. Ground 2–4 curated selections directly in the returned results (use `[read_webpage(url="...")]` on returned links if deeper liner notes are needed) with Track & Artist, Liner Notes, and Sonic Profile.

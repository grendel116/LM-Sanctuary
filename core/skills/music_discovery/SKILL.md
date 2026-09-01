---
name: music_discovery
description: Discover deep cuts, forgotten outcasts, obscure tracks, underground artists, and rare grooves with rich cultural lore and liner-note storytelling.
summary: "Discover deep cuts, forgotten artists, and underground music using [search_music(query=\"...\", mode=\"deep_cuts|kexp|theme_time|bandcamp|artist\")]"
retrieval: vector
triggers: music, song, songs, artist, artists, musician, track
---
# SKILL: Music Discovery ("Deep Cuts & Obscure Grooves")
When discussing songs, recommending music, or asked to find tracks, artists, or deep cuts:

### 1. Curatorial Ethos
- **Seek the Overlooked**: Focus on forgotten B-sides, private-press vinyl, cult reissues (Numero Group, Light in the Attic, Soul Jazz, Sublime Frequencies), outsider artists, regional micro-scenes, and non-commercial gems.
- **Liner-Note Lore & Historical Context**: Frame discoveries with the artist's backstory, recording conditions, historical circumstances, session players, and cultural lineage.
- **Sonic Profiling**: Describe the textures, instrumentation, rhythmic feel, vocal character, and emotional resonance.

### 2. Exploration Protocol
1. Use `search_music` to unearth tracks and artist backgrounds:
   - `[search_music(query="<artist or theme>", mode="deep_cuts")]`: Broad crate-digging for obscure recordings, reissues, and cult classics.
   - `[search_music(query="<genre or artist>", mode="kexp")]`: Explores underground indie, post-punk, and global sounds.
   - `[search_music(query="<theme or mood>", mode="theme_time")]`: Explores thematic connections across vintage blues, outlaw country, rockabilly, dub, and oddities.
   - `[search_music(query="<artist or genre>", mode="bandcamp")]`: Finds independent, self-released, and current underground music.
   - `[search_music(query="<artist name>", mode="artist")]`: Pulls structured MusicBrainz tags, discography, aliases, and origin details.
2. If a specific obscure artist or album is discovered, use `[read_webpage(url="...")]` on relevant Discogs, Bandcamp, or review links to pull liner notes and recording history.
3. Present your recommendations as a curated set:
   - **Track & Artist** (Year, Label/Origin)
   - **Why It Matters / The Lore** (The human story behind the recording)
   - **Sonic Vibe** (What it sounds like and what makes it special)

---
name: agent-media
description: Generate media (images, video, audio). Use for creating visual content, video clips, and text-to-speech.
allowed-tools: Bash(agent-media:*)
---

# Media Generation with agent-media

Generate images, video, and audio from text prompts.

## Quick Start

```bash
# Generate an image
agent-media image "mountain landscape at sunset" --output mountain.png

# Generate audio (text-to-speech)
agent-media audio "Hello, welcome to my blog" --output intro.mp3

# Start video generation (async)
agent-media video "waves crashing on a beach" --start
```

## Image Generation

```bash
agent-media image "prompt"                       # Auto-named output
agent-media image "prompt" --output hero.png     # Specific path
agent-media image "prompt" --count 4             # Multiple images
agent-media image "prompt" --size 1024x1792      # Custom size (portrait)
agent-media image "prompt" --quality hd          # Higher quality
agent-media image "prompt" --dry-run             # Estimate cost only
```

**Options:**
- `--size`: 1024x1024 (default), 1024x1792, 1792x1024
- `--count`: Number of images (DALL-E 3 generates one at a time)
- `--quality`: standard (default) or hd
- `--style`: natural or vivid
- `--max-cost`: Abort if estimated cost exceeds this (default: $1)

## Audio Generation (TTS)

```bash
agent-media audio "text to speak"                # Auto-named output
agent-media audio "text" --output intro.mp3      # Specific path
agent-media audio "text" --voice nova            # Different voice
agent-media audio "text" --format wav            # Different format
agent-media audio "text" --speed 1.2             # Faster speech
```

**Options:**
- `--voice`: alloy (default), echo, fable, onyx, nova, shimmer
- `--format`: mp3 (default), wav, opus, aac, flac
- `--speed`: 0.25 to 4.0 (default: 1.0)

## Video Generation

Video generation is **asynchronous** - it takes 1-5 minutes. Use background agents.

```bash
# Start generation (returns immediately with job ID)
agent-media video "a cat playing piano" --start
# → {"jobId": "abc123", ...}

# Check status
agent-media video --check abc123

# Download when complete
agent-media video --download abc123 --output cat.mp4

# List all jobs
agent-media video --jobs
```

**Warning:** Video URLs expire after 48 hours. Download promptly!

### Background Agent Pattern

For video generation, spawn a background agent to wait for completion:

```
1. Run: agent-media video "prompt" --start --json
2. Spawn background agent with prompt:
   "Poll video job {jobId} every 30 seconds using `agent-media video --check {jobId} --json`.
    When status is 'completed', download with `agent-media video --download {jobId} --output video.mp4`.
    Report the final file path when done."
3. Continue with other work while video generates
```

## Cost Safety

Always estimate costs before expensive operations:

```bash
# Check cost before generating
agent-media image "cat" --count 10 --dry-run
# → Estimated: 10 images @ $0.04 = $0.40

agent-media video "waves" --dry-run
# → Estimated: 5s video @ $0.35/s = $1.75

# Set cost limit
agent-media video "waves" --max-cost 2.00
```

**Approximate Pricing:**
- Images: $0.04-0.12 per image (DALL-E 3)
- Video: $0.35 per second (Veo)
- Audio: $0.015 per 1K characters

## Video Post-Processing

### Captions (Whisper + ffmpeg)

Burns word-by-word captions into video. Requires `OPENAI_API_KEY`.

```bash
# Default: black text, white outline, size 28, bottom position
agent-media caption video.mp4 -o captioned.mp4

# TikTok/Reels style: thick white border, bold black text, ALL CAPS
agent-media caption video.mp4 -o captioned.mp4 \
  --color black --outline-color white --outline-size 5 --uppercase

# White text with black outline (classic subtitle look)
agent-media caption video.mp4 -o captioned.mp4 \
  --color white --outline-color black --outline-size 3

# Custom hex colors, larger font, top position
agent-media caption video.mp4 -o captioned.mp4 \
  --color "#FFFF00" --outline-color "#000000" --font-size 36 --position top

# Line-style (5 words at a time) with custom vertical margin
agent-media caption video.mp4 -o captioned.mp4 \
  --style line --margin-v 80

# Known script for better Whisper accuracy on TTS audio
agent-media caption video.mp4 -o captioned.mp4 \
  --whisper-prompt "Hello everyone, welcome to this tutorial."
```

**Caption options:**
- `--style`: `word` (default, one word at a time) or `line` (5-word chunks)
- `--font-size`: pixels, default 28
- `--position`: `bottom` (default) or `top`
- `--color`: text color — named (`black`, `white`, `yellow`, `red`) or `#RRGGBB` (default: `black`)
- `--uppercase`: render all text in ALL CAPS
- `--outline-size`: border thickness 0–8 px (default: 2). BorderStyle=1 traces letter shapes. Use 4–6 for viral thick-border look.
- `--outline-color`: border color — named or `#RRGGBB` (default: `white`)
- `--margin-v`: vertical margin from edge in pixels (default: 40)
- `--language`: BCP-47 code for Whisper (default: `en`)
- `--whisper-prompt`: hint text to improve Whisper accuracy on AI TTS audio
- `--keep-intermediates`: save `.ass` and `whisper-raw.json` alongside output

### Assemble (concat clips)

```bash
agent-media assemble clip1.mp4 clip2.mp4 clip3.mp4 -o final.mp4
agent-media assemble clip1.mp4 clip2.mp4 -o final.mp4 --transition fade
agent-media assemble clip1.mp4 clip2.mp4 -o final.mp4 --transition fade --transition-duration 0.8
```

**Transitions:** `cut` (default, stream-copy) | `fade` (crossfade dissolve + audio fade)

### Merge Audio

```bash
agent-media merge-audio silent.mp4 voiceover.mp3 -o final.mp4
```

### Trim Silence

```bash
agent-media trim raw.mp4 -o tight.mp4
agent-media trim raw.mp4 -o tight.mp4 --threshold -40 --min-silence 0.2
```

## Frame (9:16 Hook Banner)

Add a hook text banner above or below a video within a 1080×1920 (9:16) canvas:

```bash
agent-media frame input.mp4 \
  --hook "What your body actually needs every day" \
  -o framed.mp4

# White background, hook at bottom
agent-media frame input.mp4 \
  --hook "You won't believe what happened next" \
  --background white --hook-position bottom \
  -o framed.mp4

# Custom video scale and font size
agent-media frame input.mp4 \
  --hook "3 things nobody tells you about sleep" \
  --video-scale 0.80 --font-size 48 \
  -o framed.mp4 --json
```

**Options:**
- `--hook <text>`: Hook text displayed in the padding area (required)
- `--hook-position`: `top` (default) or `bottom`
- `--video-scale`: Fraction of frame height the video occupies, 0.1–0.95 (default: 0.70)
- `--background`: `black` (default) or `white`
- `--font-size`: Hook text size in points (default: 52)

Text color is always the inverse of background (white on black, black on white).
Requires `fonts-dejavu` (`apt-get install fonts-dejavu` on Ubuntu).

## Utility Commands

```bash
# List available adapters
agent-media list

# Show adapter capabilities and pricing
agent-media capabilities openai
agent-media capabilities google
```

## Environment Variables

```bash
OPENAI_API_KEY=...    # Required for image and audio
GOOGLE_API_KEY=...    # Required for video (or GEMINI_API_KEY)
```

## Example: Blog Post with Images

```bash
# Check costs first
agent-media image "dramatic sunset" --dry-run
# → $0.04

# Generate hero image
agent-media image "dramatic sunset over mountains, photorealistic" --output hero.png

# Generate supporting images
agent-media image "hiking trail through autumn forest" --output trail.png
agent-media image "cozy cabin with smoke from chimney" --output cabin.png

# Add narration
agent-media audio "Welcome to my adventure blog. Today we explore the mountains." --output intro.mp3
```

## Example: Video with Background Agent

```bash
# Start video generation
agent-media video "timelapse of clouds over mountains" --start --json
# Returns: {"jobId": "veo-123...", "checkCommand": "agent-media video --check veo-123..."}

# In Claude Code, spawn background agent to monitor:
# Task: "Poll job veo-123 using agent-media video --check veo-123 --json every 30s.
#        When complete, download to clouds.mp4 and notify me."

# Continue working on other tasks...
# Background agent will notify when video is ready
```

## Verification

**What to check:** Image generation calls the real DALL-E API and produces an output file that is a valid, non-empty image. The generated image URL must be accessible and the file must render.

**How to run:**
```bash
agent-media image generate --prompt "a red circle on a white background" --output /tmp/verify-media.png
# Confirm file exists and is a valid PNG
file /tmp/verify-media.png
# Output must contain "PNG image data" — not "empty" or "ASCII text"
ls -lh /tmp/verify-media.png
# File size must be > 10KB (a real image, not an error page)
```

**What failure mode it catches:** An expired or missing API key, an exhausted billing quota, or a broken network path to the OpenAI endpoint will cause the command to exit with an error or write an empty/corrupt file. Checking only exit code 0 from `agent-media image generate` is insufficient — the CLI may write a zero-byte file or a JSON error body if the upstream call fails silently. Inspecting the file type with `file` catches this: an error response saved as a PNG would be identified as "ASCII text" or "JSON data", not "PNG image data".

**Why it cannot be gamed:** A real PNG with content requires the OpenAI DALL-E API to accept the request, generate an image, and return a URL that resolves to binary image data. The `file` command reads the magic bytes of the downloaded artifact — a mock or empty response cannot produce valid PNG magic bytes (`\x89PNG`).

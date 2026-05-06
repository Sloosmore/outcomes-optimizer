/**
 * SRT (SubRip) generation utilities.
 *
 * Pure functions — no I/O, no external dependencies.
 * Designed to be unit-tested without ffmpeg or network access.
 */

export interface ASSStyle {
  fontName: string;
  fontSize: number;
  primaryColour: string; // &HAABBGGRR
  outlineColour: string;
  bold: boolean;
  outline: number;      // border thickness in pixels (BorderStyle=1: traces letter shapes)
  shadow: number;
  alignment: number;    // 2=bottom-center 8=top-center
  marginV: number;
  borderStyle?: number; // 1=character outline (default), 4=opaque box
  uppercase?: boolean;  // render all text in ALL CAPS
}

/**
 * Generate an ASS (Advanced SubStation Alpha) subtitle file with styling baked in.
 *
 * Using ASS avoids the force_style quoting hell in ffmpeg's filter syntax —
 * the style lives in the file, not in the -vf argument.
 */
export function generateASS(words: WordTimestamp[], style: "word" | "line", assStyle: ASSStyle): string {
  const bold = assStyle.bold ? "-1" : "0";
  const borderStyle = assStyle.borderStyle ?? 1;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${assStyle.fontName},${assStyle.fontSize},${assStyle.primaryColour},&H000000FF,${assStyle.outlineColour},&H00000000,${bold},0,0,0,100,100,0,0,${borderStyle},${assStyle.outline},${assStyle.shadow},${assStyle.alignment},10,10,${assStyle.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  function toASSTime(seconds: number): string {
    const totalCs = Math.round(Math.max(0, seconds) * 100);
    const cs = totalCs % 100;
    const totalSec = Math.floor(totalCs / 100);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }

  function formatText(word: string): string {
    return assStyle.uppercase ? word.toUpperCase() : word;
  }

  let dialogues: string[] = [];

  if (style === "word") {
    dialogues = words.map(
      (w) => `Dialogue: 0,${toASSTime(w.start)},${toASSTime(w.end)},Default,,0,0,0,,${formatText(w.word)}`
    );
  } else {
    const chunkSize = 5;
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize);
      const text = formatText(chunk.map((w) => w.word).join(" "));
      dialogues.push(
        `Dialogue: 0,${toASSTime(chunk[0].start)},${toASSTime(chunk[chunk.length - 1].end)},Default,,0,0,0,,${text}`
      );
    }
  }

  return header + "\n" + dialogues.join("\n") + "\n";
}

export interface WordTimestamp {
  word: string;
  start: number; // seconds
  end: number;   // seconds
}

/**
 * Convert a time in seconds to SRT timestamp format: HH:MM:SS,mmm
 *
 * Works in integer milliseconds throughout to avoid floating-point rollover
 * when ms rounds to 1000.
 */
export function toSRTTime(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return (
    String(hh).padStart(2, "0") +
    ":" +
    String(mm).padStart(2, "0") +
    ":" +
    String(ss).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

/**
 * Generate an SRT file string from Whisper word-level timestamps.
 *
 * - "word"  style: one entry per word (viral word-by-word pop-up effect)
 * - "line"  style: groups of ~5 words per entry
 */
export function generateSRT(
  words: WordTimestamp[],
  style: "word" | "line"
): string {
  if (words.length === 0) return "";

  if (style === "word") {
    return words
      .map((w, i) => {
        const start = toSRTTime(w.start);
        const end = toSRTTime(w.end);
        return `${i + 1}\n${start} --> ${end}\n${w.word}\n`;
      })
      .join("\n");
  }

  // "line" style: group into chunks of 5 words
  const chunkSize = 5;
  const entries: string[] = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize);
    const start = toSRTTime(chunk[0].start);
    const end = toSRTTime(chunk[chunk.length - 1].end);
    const text = chunk.map((w) => w.word).join(" ");
    entries.push(`${entries.length + 1}\n${start} --> ${end}\n${text}\n`);
  }
  return entries.join("\n");
}

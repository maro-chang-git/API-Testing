/**
 * DOM-free Server-Sent-Events parsing for the Try It tab.
 *
 * A `text/event-stream` body is a sequence of events separated by blank lines;
 * each event is a set of `field: value` lines (`event:`, `data:`, `id:`, or a
 * `:comment`/heartbeat). Per the SSE spec, multiple `data:` lines in one event
 * are joined with "\n" and a single leading space after the colon is stripped.
 *
 * The dev proxy buffers the whole stream, so we parse the complete body at once
 * into events and best-effort reconstruct the streamed text from the common
 * chat-delta shapes — letting the user read the assembled message instead of raw
 * frames. Pure (no DOM) so it can be unit-tested.
 */

const STREAM_CT = /text\/event-stream/i;

/** True when the response is an SSE stream — by content-type, or by sniffing a
 *  body whose first non-empty line is an SSE field. */
export function isEventStream(contentType = '', body = '') {
  if (STREAM_CT.test(contentType)) return true;
  const first = String(body).trimStart().toLowerCase();
  return first.startsWith('data:') || first.startsWith('event:');
}

/** Parses a raw SSE body → { events: [{ event, data, json }], text, count }. */
export function parseEventStream(raw = '') {
  const events = [];
  const blocks = String(raw).replace(/\r\n/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    let name = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;                 // comment / heartbeat
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value   = idx === -1 ? ''   : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);  // strip one leading space
      if (field === 'event')     name = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) continue;

    const data = dataLines.join('\n');
    let json = null;
    try { json = JSON.parse(data); } catch { /* non-JSON data — keep raw */ }
    events.push({ event: name, data, json });
  }

  const text = events.map(e => deltaText(e.json)).join('');
  return { events, text, count: events.length };
}

// Best-effort incremental text from a parsed SSE data object, covering the
// common streaming-chat shapes (Anthropic + OpenAI). Returns '' for control
// frames (message_start, ping, message_stop, …).
function deltaText(json) {
  if (!json || typeof json !== 'object') return '';
  // Anthropic: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
  if (json.delta && typeof json.delta.text === 'string') return json.delta.text;
  // OpenAI: { choices: [{ delta: { content } }] }
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (choice && choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  return '';
}

/**
 * Lightweight Prometheus metrics registry for LLMock.
 *
 * Zero external dependencies — implements counters, histograms, and gauges
 * with Prometheus text exposition format serialization.
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MetricsRegistry {
  incrementCounter(name: string, labels: Record<string, string>): void;
  observeHistogram(name: string, labels: Record<string, string>, value: number): void;
  setGauge(name: string, labels: Record<string, string>, value: number): void;
  serialize(): string;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Histogram bucket boundaries (Prometheus default-ish)
// ---------------------------------------------------------------------------

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a stable label key string for map lookups: `label1="v1",label2="v2"` */
function labelKey(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
}

/** Escape a label value per Prometheus text exposition format. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Format labels for Prometheus output: `{label1="v1",label2="v2"}` */
function formatLabels(labels: Record<string, string>): string {
  return `{${labelKey(labels)}}`;
}

// ---------------------------------------------------------------------------
// Internal metric storage types
// ---------------------------------------------------------------------------

interface CounterData {
  type: "counter";
  /** Map from labelKey → value */
  series: Map<string, { labels: Record<string, string>; value: number }>;
}

interface HistogramData {
  type: "histogram";
  /** Map from labelKey → bucket counts, sum, count */
  series: Map<
    string,
    {
      labels: Record<string, string>;
      bucketCounts: number[]; // one per HISTOGRAM_BUCKETS entry
      sum: number;
      count: number;
    }
  >;
}

interface GaugeData {
  type: "gauge";
  /** Map from labelKey → value */
  series: Map<string, { labels: Record<string, string>; value: number }>;
}

type MetricData = CounterData | HistogramData | GaugeData;

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

export function createMetricsRegistry(): MetricsRegistry {
  /** Ordered map: metric name → data. Insertion order preserved for stable output. */
  const metrics = new Map<string, MetricData>();

  function getOrCreateCounter(name: string): CounterData {
    let data = metrics.get(name);
    if (!data) {
      data = { type: "counter", series: new Map() };
      metrics.set(name, data);
    }
    if (data.type !== "counter") throw new Error(`Metric ${name} is not a counter`);
    return data as CounterData;
  }

  function getOrCreateHistogram(name: string): HistogramData {
    let data = metrics.get(name);
    if (!data) {
      data = { type: "histogram", series: new Map() };
      metrics.set(name, data);
    }
    if (data.type !== "histogram") throw new Error(`Metric ${name} is not a histogram`);
    return data as HistogramData;
  }

  function getOrCreateGauge(name: string): GaugeData {
    let data = metrics.get(name);
    if (!data) {
      data = { type: "gauge", series: new Map() };
      metrics.set(name, data);
    }
    if (data.type !== "gauge") throw new Error(`Metric ${name} is not a gauge`);
    return data as GaugeData;
  }

  return {
    incrementCounter(name: string, labels: Record<string, string>): void {
      const counter = getOrCreateCounter(name);
      const key = labelKey(labels);
      const existing = counter.series.get(key);
      if (existing) {
        existing.value += 1;
      } else {
        counter.series.set(key, { labels, value: 1 });
      }
    },

    observeHistogram(name: string, labels: Record<string, string>, value: number): void {
      const histogram = getOrCreateHistogram(name);
      const key = labelKey(labels);
      let existing = histogram.series.get(key);
      if (!existing) {
        existing = {
          labels,
          bucketCounts: new Array(HISTOGRAM_BUCKETS.length).fill(0) as number[],
          sum: 0,
          count: 0,
        };
        histogram.series.set(key, existing);
      }
      // Update cumulative bucket counts
      for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
        if (value <= HISTOGRAM_BUCKETS[i]) {
          existing.bucketCounts[i] += 1;
        }
      }
      existing.sum += value;
      existing.count += 1;
    },

    setGauge(name: string, labels: Record<string, string>, value: number): void {
      const gauge = getOrCreateGauge(name);
      const key = labelKey(labels);
      const existing = gauge.series.get(key);
      if (existing) {
        existing.value = value;
      } else {
        gauge.series.set(key, { labels, value });
      }
    },

    serialize(): string {
      const lines: string[] = [];

      for (const [name, data] of metrics) {
        switch (data.type) {
          case "counter": {
            lines.push(`# TYPE ${name} counter`);
            for (const series of data.series.values()) {
              lines.push(`${name}${formatLabels(series.labels)} ${series.value}`);
            }
            break;
          }
          case "histogram": {
            lines.push(`# TYPE ${name} histogram`);
            for (const series of data.series.values()) {
              const lblStr = labelKey(series.labels);
              const lblPrefix = lblStr ? `${lblStr},` : "";
              // Bucket lines
              for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
                lines.push(
                  `${name}_bucket{${lblPrefix}le="${HISTOGRAM_BUCKETS[i]}"} ${series.bucketCounts[i]}`,
                );
              }
              // +Inf bucket
              lines.push(`${name}_bucket{${lblPrefix}le="+Inf"} ${series.count}`);
              // Sum and count
              lines.push(`${name}_sum${formatLabels(series.labels)} ${series.sum}`);
              lines.push(`${name}_count${formatLabels(series.labels)} ${series.count}`);
            }
            break;
          }
          case "gauge": {
            lines.push(`# TYPE ${name} gauge`);
            for (const series of data.series.values()) {
              lines.push(`${name}${formatLabels(series.labels)} ${series.value}`);
            }
            break;
          }
        }
      }

      return lines.length > 0 ? lines.join("\n") + "\n" : "";
    },

    reset(): void {
      metrics.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Path normalization for metric labels
// ---------------------------------------------------------------------------

// Regex patterns for parametric API routes
const BEDROCK_RE =
  /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|converse|converse-stream)$/;
const GEMINI_RE = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/;
const AZURE_RE = /^\/openai\/deployments\/([^/]+)\/(chat\/completions|embeddings)$/;
const ELEVENLABS_TTS_RE = /^\/v1\/text-to-speech\/([^/]+)$/;
const VERTEX_RE =
  /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^:]+):(.+)$/;
// Exported: server.ts route dispatch matches the same OpenRouter and OpenAI
// video paths.
export const OPENROUTER_VIDEO_CONTENT_RE = /^\/api\/v1\/videos\/([^/]+)\/content$/;
export const OPENROUTER_VIDEO_STATUS_RE = /^\/api\/v1\/videos\/([^/]+)$/;
export const OPENAI_VIDEO_STATUS_RE = /^\/v1\/videos\/([^/]+)$/;
// Exported: server.ts route dispatch matches the same Google Veo and xAI Grok
// video paths. Veo submit (`:predictLongRunning`) is anchored so it never
// collides with the bare Gemini `:predict` route; Veo operations live in a
// fresh `/v1beta/operations/...` namespace. Grok submit is an exact literal
// path; Grok status reuses the OpenAI `/v1/videos/{id}` shape (the dispatch
// guards `id !== "generations"` and the job-map lookup disambiguates Sora).
export const VEO_PREDICT_LRO_RE = /^\/v1beta\/models\/([^:]+):predictLongRunning$/;
export const VEO_OPERATION_RE = /^\/v1beta\/(operations\/.+)$/;
export const GROK_VIDEO_SUBMIT_PATH = "/v1/videos/generations";
export const GROK_VIDEO_STATUS_RE = /^\/v1\/videos\/([^/]+)$/;

/**
 * BytePlus Ark (Seedance) async video task routes. The `/api/v3` prefix is
 * ENUMERATED rather than wildcarded: Ark's data-plane base carries it, but a
 * client may point `baseURL` at a bare aimock root instead, so both forms must
 * route. A tolerant `(?:\/[^?]*)?` prefix would additionally claim
 * `/fal/contents/generations/tasks` — and these routes dispatch in the
 * pre-rewrite band, ~1,100 lines ahead of every fal branch, so it would take
 * that path away from the fal proxy. Enumerating the one real prefix also
 * blocks a doubled suffix from matching the status RE.
 *
 * Declared here (not in server.ts) because normalizePathLabel below consumes
 * them, matching the existing OpenRouter/Veo/Grok route-regex edge where
 * server.ts imports its route regexes from this module.
 */
export const BYTEPLUS_VIDEO_SUBMIT_RE = /^(?:\/api\/v3)?\/contents\/generations\/tasks$/;
export const BYTEPLUS_VIDEO_STATUS_RE = /^(?:\/api\/v3)?\/contents\/generations\/tasks\/([^/]+)$/;

/**
 * Fine-tuning routes. Both id families (`ftjob-…` per create, `ftckpt-…` per
 * checkpoint) are minted per resource, so every id-bearing path has to collapse
 * or each job and each checkpoint mints its own label pair.
 *
 * The label hazard is NOT limited to the routes this server implements: metrics
 * are recorded on `res.on("finish")` for EVERY response, the generic 404
 * included, and `openai@4.104.0` calls a good deal more of the namespace than
 * aimock handles. Enumerated from that SDK:
 *
 *   - `resources/fine-tuning/jobs/jobs.js` — `/fine_tuning/jobs`,
 *     `…/jobs/{id}`, `…/jobs/{id}/cancel`, `…/jobs/{id}/pause`,
 *     `…/jobs/{id}/resume`
 *   - `resources/fine-tuning/jobs/checkpoints.js` — `…/jobs/{id}/checkpoints`
 *   - `resources/fine-tuning/checkpoints/permissions.js` —
 *     `…/checkpoints/{ckpt}/permissions` (create/list) and
 *     `…/checkpoints/{ckpt}/permissions/{id}` (delete)
 *   - `resources/fine-tuning/alpha/graders.js` —
 *     `/fine_tuning/alpha/graders/run`, `/fine_tuning/alpha/graders/validate`
 *
 * The grader routes carry no ids, so they need no placeholder — but they DO
 * need naming here, because the namespace cascade below ends in a catch-all
 * and a static route must not be swallowed by it.
 *
 * Every segment after `/v1/fine_tuning/` is caller-controlled, so the rule is:
 * known action names are kept verbatim, ids collapse to `{id}`/`{ckpt}`, and
 * anything else — an unknown action, an unknown depth — collapses to a single
 * bucket. That is what actually keeps the fine-tuning label set finite no
 * matter what is requested; an un-collapsed tail would leave the hole open to
 * a typo or a fuzzer.
 *
 * Not exported: server.ts routes fine-tuning with its own private REs.
 */
const FINE_TUNING_PREFIX = "/v1/fine_tuning/";
const FINE_TUNING_STATIC_PATHS = new Set([
  "/v1/fine_tuning/jobs",
  "/v1/fine_tuning/alpha/graders/run",
  "/v1/fine_tuning/alpha/graders/validate",
]);
const FINE_TUNING_SUBRESOURCE_RE = /^\/v1\/fine_tuning\/jobs\/[^/]+\/([^/]+)$/;
const FINE_TUNING_SUBRESOURCES = new Set(["cancel", "events", "pause", "resume", "checkpoints"]);
const FINE_TUNING_ID_RE = /^\/v1\/fine_tuning\/jobs\/([^/]+)$/;
const FINE_TUNING_PERMISSION_ID_RE = /^\/v1\/fine_tuning\/checkpoints\/[^/]+\/permissions\/[^/]+$/;
const FINE_TUNING_CHECKPOINT_SUBRESOURCE_RE = /^\/v1\/fine_tuning\/checkpoints\/[^/]+\/([^/]+)$/;
const FINE_TUNING_CHECKPOINT_SUBRESOURCES = new Set(["permissions"]);
const FINE_TUNING_CHECKPOINT_ID_RE = /^\/v1\/fine_tuning\/checkpoints\/([^/]+)$/;
const FINE_TUNING_OTHER_LABEL = "/v1/fine_tuning/{other}";

/**
 * Normalize parametric API paths to route patterns for use as metric labels.
 * Replaces dynamic segments (model IDs, deployment names, etc.) with placeholders.
 */
export function normalizePathLabel(pathname: string): string {
  // Bedrock: /model/{modelId}/{operation}
  const bedrockMatch = pathname.match(BEDROCK_RE);
  if (bedrockMatch) {
    return `/model/{modelId}/${bedrockMatch[2]}`;
  }

  // Gemini: /v1beta/models/{model}:{action}
  const geminiMatch = pathname.match(GEMINI_RE);
  if (geminiMatch) {
    return `/v1beta/models/{model}:${geminiMatch[2]}`;
  }

  // Azure: /openai/deployments/{id}/{operation}
  const azureMatch = pathname.match(AZURE_RE);
  if (azureMatch) {
    return `/openai/deployments/{id}/${azureMatch[2]}`;
  }

  // Vertex AI: /v1/projects/{p}/locations/{l}/publishers/google/models/{m}:{action}
  const vertexMatch = pathname.match(VERTEX_RE);
  if (vertexMatch) {
    return `/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:${vertexMatch[4]}`;
  }

  // ElevenLabs TTS: /v1/text-to-speech/{voice_id}
  if (ELEVENLABS_TTS_RE.test(pathname)) {
    return "/v1/text-to-speech/{voice_id}";
  }

  // OpenRouter video: /api/v1/videos/{jobId}[/content] — jobIds are random
  // UUIDs, so raw paths would mint unbounded label cardinality. The static
  // /api/v1/videos/models listing route must not collapse into {jobId}.
  if (OPENROUTER_VIDEO_CONTENT_RE.test(pathname)) {
    return "/api/v1/videos/{jobId}/content";
  }
  if (pathname !== "/api/v1/videos/models" && OPENROUTER_VIDEO_STATUS_RE.test(pathname)) {
    return "/api/v1/videos/{jobId}";
  }

  // Google Veo video: submit `:predictLongRunning` + poll `/v1beta/operations/{name}`.
  // Operation names are random UUIDs, so the raw path would mint unbounded
  // label cardinality.
  if (VEO_PREDICT_LRO_RE.test(pathname)) {
    return "/v1beta/models/{model}:predictLongRunning";
  }
  if (VEO_OPERATION_RE.test(pathname)) {
    return "/v1beta/operations/{name}";
  }

  // xAI Grok Imagine submit is a static literal path — keep it distinct from
  // the `/v1/videos/{id}` status label below (which it would otherwise collapse
  // into), exactly as `/api/v1/videos/models` is kept out of the jobId bucket.
  if (pathname === GROK_VIDEO_SUBMIT_PATH) {
    return GROK_VIDEO_SUBMIT_PATH;
  }

  // OpenAI/Grok video status: /v1/videos/{id}
  if (OPENAI_VIDEO_STATUS_RE.test(pathname)) {
    return "/v1/videos/{id}";
  }

  // BytePlus Ark video: /[api/v3/]contents/generations/tasks[/{id}] — task ids
  // (`cgt-…`) are unbounded cardinality. Status before submit: the status RE is
  // the more specific of the two and the submit RE cannot match a trailing id
  // segment, so the order is belt-and-braces. Appended at the end of the
  // cascade because the anchored REs above cannot match any path an earlier
  // entry claims.
  if (BYTEPLUS_VIDEO_STATUS_RE.test(pathname)) {
    return "/contents/generations/tasks/{id}";
  }
  if (BYTEPLUS_VIDEO_SUBMIT_RE.test(pathname)) {
    return "/contents/generations/tasks";
  }

  // Fine-tuning. Handled as one closed namespace rather than a few loose REs:
  // the cascade is entered by prefix and always returns, so no fine-tuning path
  // can reach the verbatim return at the bottom of this function.
  //
  // Order matters twice. The id-bearing permission rule reads before the
  // checkpoint sub-resource rule, because `…/permissions/{id}` would otherwise
  // never be reached (its own second segment is the id). Within each family the
  // sub-resource rule reads before the id rule; the id REs are anchored to a
  // single trailing segment so the two cannot both match, but the more specific
  // path reading first is what makes the cascade legible.
  if (pathname.startsWith(FINE_TUNING_PREFIX)) {
    if (FINE_TUNING_STATIC_PATHS.has(pathname)) return pathname;

    const ftSubresource = pathname.match(FINE_TUNING_SUBRESOURCE_RE);
    if (ftSubresource) {
      const action = FINE_TUNING_SUBRESOURCES.has(ftSubresource[1]) ? ftSubresource[1] : "{action}";
      return `/v1/fine_tuning/jobs/{id}/${action}`;
    }
    if (FINE_TUNING_ID_RE.test(pathname)) return "/v1/fine_tuning/jobs/{id}";

    if (FINE_TUNING_PERMISSION_ID_RE.test(pathname)) {
      return "/v1/fine_tuning/checkpoints/{ckpt}/permissions/{id}";
    }
    const ckptSubresource = pathname.match(FINE_TUNING_CHECKPOINT_SUBRESOURCE_RE);
    if (ckptSubresource) {
      const action = FINE_TUNING_CHECKPOINT_SUBRESOURCES.has(ckptSubresource[1])
        ? ckptSubresource[1]
        : "{action}";
      return `/v1/fine_tuning/checkpoints/{ckpt}/${action}`;
    }
    if (FINE_TUNING_CHECKPOINT_ID_RE.test(pathname)) {
      return "/v1/fine_tuning/checkpoints/{ckpt}";
    }

    return FINE_TUNING_OTHER_LABEL;
  }

  // Static path — return as-is
  return pathname;
}

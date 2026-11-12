/**
 * Report-extraction provider selection for the Marketing Agent.
 *
 * Script Properties:
 *   MARKETING_EXTRACTION_PROVIDER  "gemini" (default when unset) or "openai"
 *   OPENAI_API_KEY                 required when the provider is "openai"
 *   OPENAI_EXTRACTION_MODEL        optional, defaults to gpt-6-luna
 *   OPENAI_REASONING_EFFORT        optional, sent only when set (for example "low")
 *   OPENAI_INPUT_USD_PER_1M_TOKENS / OPENAI_OUTPUT_USD_PER_1M_TOKENS
 *                                  optional prices used only for the cost estimate
 *
 * Every provider returns the same Gemini-shaped response, so the section job,
 * staging, importer and actionable output are unchanged. There is deliberately no
 * automatic fallback between providers: each result is attributable to one provider.
 */

const MARKETING_OPENAI_URL = "https://api.openai.com/v1/responses";
const MARKETING_OPENAI_DEFAULT_MODEL = "gpt-6-luna";
const MARKETING_OPENAI_MAX_OUTPUT_TOKENS = 32000;

// Strict structured output requires an object root and every key present, so
// unavailable values are null and are dropped before reaching the importer.
const MARKETING_OPENAI_FIELDS = {
  name_dj_alias: "Name / DJ Alias", first_name: "First Name", last_name: "Last Name",
  additional_info_stations: "Additional Info / Stations", radio_station: "Radio Station",
  reach: "Reach", rating: "Rating", favorite_track: "Favorite Track", comments: "Comments",
  email_address: "Email Address", phone_number: "Phone Number",
  social_media_account: "Social Media Account", city: "City", state_region: "State/Region",
  country: "Country", music_genre: "Music Genre", campaign_release: "Campaign / Release",
  report_generated_at: "Report Generated At", campaign_status: "Campaign Status",
  activity_time: "Activity Time", downloaded: "Downloaded", downloads: "Downloads",
  listened: "Listened", listens: "Listens"
};

let MARKETING_EXTRACTION_USAGE = {};

function marketingResetExtractionUsage_() {
  MARKETING_EXTRACTION_USAGE = {};
}

function marketingExtractionProvider_() {
  const props = PropertiesService.getScriptProperties();
  const name = String(props.getProperty("MARKETING_EXTRACTION_PROVIDER") || "gemini").trim().toLowerCase();
  if (name === "gemini")
    return {name: name, label: "Gemini", stage: "GEMINI_SECTION", keyProperty: "GEMINI_API_KEY"};
  if (name === "openai")
    return {name: name, label: "OpenAI", stage: "OPENAI_SECTION", keyProperty: "OPENAI_API_KEY",
      model: String(props.getProperty("OPENAI_EXTRACTION_MODEL") || "").trim() || MARKETING_OPENAI_DEFAULT_MODEL};
  throw new Error("Unsupported MARKETING_EXTRACTION_PROVIDER '" + name + "'; use gemini or openai.");
}

function marketingRecordExtractionUsage_(provider, model, milliseconds, usage) {
  const entry = MARKETING_EXTRACTION_USAGE[provider] = MARKETING_EXTRACTION_USAGE[provider] ||
    {model: model, requests: 0, seconds: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0};
  entry.requests++;
  entry.seconds = Math.round((entry.seconds + milliseconds / 1000) * 10) / 10;
  if (!usage) return entry;
  entry.inputTokens += usage.input || 0;
  entry.outputTokens += usage.output || 0;
  entry.reasoningTokens += usage.reasoning || 0;
  if (provider === "OpenAI") {
    const props = PropertiesService.getScriptProperties();
    const inputPrice = Number(props.getProperty("OPENAI_INPUT_USD_PER_1M_TOKENS"));
    const outputPrice = Number(props.getProperty("OPENAI_OUTPUT_USD_PER_1M_TOKENS"));
    // Reasoning tokens are billed as output tokens and are already included in them.
    if (inputPrice > 0 && outputPrice > 0)
      entry.estimatedUsd = Math.round((entry.inputTokens * inputPrice + entry.outputTokens * outputPrice) / 100) / 1e4;
  }
  return entry;
}

function marketingOpenAISchema_() {
  const properties = {};
  Object.keys(MARKETING_OPENAI_FIELDS).forEach(key => { properties[key] = {type: ["string", "null"]}; });
  properties.additional_fields = {
    type: "array",
    items: {type: "object", additionalProperties: false, required: ["field", "value"],
      properties: {field: {type: "string"}, value: {type: "string"}}}
  };
  return {
    type: "object", additionalProperties: false, required: ["records"],
    properties: {records: {type: "array", items: {
      type: "object", additionalProperties: false, required: Object.keys(properties), properties: properties
    }}}
  };
}

function marketingOpenAIPrompt_(range) {
  return marketingExtractionPrompt_() + " " + marketingPageScope_(range) +
    " Return the recipients in the records array of the supplied JSON schema instead of a bare array." +
    " Each schema field holds the key of the same name listed above; use null when it is not present." +
    " Put any other recipient-specific field in additional_fields, using the report's own label.";
}

// Maps schema records to the existing report keys; null/blank values are omitted.
function marketingOpenAIRows_(records) {
  return records.map(record => {
    const row = {};
    Object.keys(MARKETING_OPENAI_FIELDS).forEach(key => {
      const value = record && record[key];
      if (value != null && String(value).trim() !== "") row[MARKETING_OPENAI_FIELDS[key]] = String(value);
    });
    ((record && record.additional_fields) || []).forEach(extra => {
      const field = String(extra && extra.field || "").trim();
      const value = String(extra && extra.value || "").trim();
      if (field && value && !Object.prototype.hasOwnProperty.call(row, field)) row[field] = value;
    });
    return row;
  });
}

function marketingOpenAIError_(message, permanent) {
  const error = new Error(marketingRedact_(message));
  error.permanent = !!permanent;
  return error;
}

/**
 * One bounded OpenAI Responses request for a page range. Throws a sanitized error
 * marked permanent (authentication, quota, refusal, bad request) or retryable
 * (rate limit, server error, timeout, incomplete or invalid output).
 */
function marketingOpenAIRequestSection_(data, range, provider) {
  const key = String(PropertiesService.getScriptProperties().getProperty("OPENAI_API_KEY") || "").trim();
  if (!key) throw marketingOpenAIError_("Missing Script Property: OPENAI_API_KEY", true);
  const effort = String(PropertiesService.getScriptProperties().getProperty("OPENAI_REASONING_EFFORT") || "").trim();
  const request = {
    model: provider.model,
    store: false,
    max_output_tokens: MARKETING_OPENAI_MAX_OUTPUT_TOKENS,
    input: [{role: "user", content: [
      {type: "input_file", filename: "report.pdf", file_data: "data:application/pdf;base64," + data},
      {type: "input_text", text: marketingOpenAIPrompt_(range)}
    ]}],
    text: {format: {type: "json_schema", name: "campaign_report_recipients", strict: true,
      schema: marketingOpenAISchema_()}}
  };
  if (effort) request.reasoning = {effort: effort};
  const pages = "pages " + range.first + "-" + (range.last === null ? "end" : range.last);
  API_CALL_INVENTORY["OpenAI"] = (API_CALL_INVENTORY["OpenAI"] || 0) + 1;
  const started = Date.now();
  let response;
  try {
    response = UrlFetchApp.fetch(MARKETING_OPENAI_URL, {
      method: "post",
      contentType: "application/json",
      headers: {Authorization: "Bearer " + key},
      muteHttpExceptions: true,
      timeoutSeconds: MARKETING_GEMINI_TIMEOUT_SECONDS,
      payload: JSON.stringify(request)
    });
  } catch (error) {
    marketingRecordExtractionUsage_("OpenAI", provider.model, Date.now() - started, null);
    throw marketingOpenAIError_("OpenAI request failed for " + pages + ": " + (error && error.message || error), false);
  }
  const elapsed = Date.now() - started;
  const code = response.getResponseCode();
  let body = null;
  try { body = JSON.parse(response.getContentText()); } catch (error) {}
  const usage = body && body.usage ? {
    input: body.usage.input_tokens, output: body.usage.output_tokens,
    reasoning: (body.usage.output_tokens_details || {}).reasoning_tokens
  } : null;
  const totals = marketingRecordExtractionUsage_("OpenAI", provider.model, elapsed, usage);
  console.log("OpenAI " + provider.model + " " + pages + ": HTTP " + code + " in " +
    Math.round(elapsed / 100) / 10 + " s" + (usage ? "; tokens in=" + usage.input + " out=" + usage.output +
    " reasoning=" + (usage.reasoning || 0) : "") +
    (totals.estimatedUsd != null ? "; run estimate $" + totals.estimatedUsd : ""));
  if (code !== 200) {
    const detail = (body && body.error) || {};
    const kind = detail.code || detail.type || "error";
    const transient = code === 408 || code === 409 || code >= 500 ||
      (code === 429 && kind !== "insufficient_quota");
    throw marketingOpenAIError_("OpenAI HTTP " + code + " (" + kind + ") for " + pages + ": " +
      String(detail.message || "").slice(0, 200), !transient);
  }
  if (!body) throw marketingOpenAIError_("OpenAI returned an unreadable response for " + pages, false);
  if (body.status !== "completed") {
    const reason = (body.incomplete_details || {}).reason || body.status || "unknown";
    const error = marketingOpenAIError_("OpenAI response " + (body.status || "incomplete") + " (" + reason + ") for " + pages,
      reason === "content_filter");
    error.splittable = reason === "max_output_tokens";
    throw error;
  }
  const parts = (body.output || []).filter(item => item.type === "message")
    .reduce((all, item) => all.concat(item.content || []), []);
  const refusal = parts.find(part => part.type === "refusal");
  if (refusal)
    throw marketingOpenAIError_("OpenAI refused extraction for " + pages + ": " +
      String(refusal.refusal || "").slice(0, 200), true);
  const text = parts.filter(part => part.type === "output_text").map(part => part.text || "").join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    throw marketingOpenAIError_("OpenAI returned invalid JSON for " + pages, false);
  }
  if (!parsed || !Array.isArray(parsed.records))
    throw marketingOpenAIError_("OpenAI JSON has no records array for " + pages, false);
  return marketingJsonResponse_(marketingOpenAIRows_(parsed.records));
}

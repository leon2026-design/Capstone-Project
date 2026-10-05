/**
 * API CALL INVENTORY
 * Counts every tracked outbound API request during one execution.
 */

let API_CALL_INVENTORY = {};

/**
 * Replacement wrapper for UrlFetchApp.fetch().
 *
 * @param {string} apiName Human-readable API name.
 * @param {string} url Request URL.
 * @param {Object} options UrlFetchApp options.
 * @return {HTTPResponse}
 */
function trackedFetch(apiName, url, options) {
  if (!API_CALL_INVENTORY[apiName]) {
    API_CALL_INVENTORY[apiName] = 0;
  }

  API_CALL_INVENTORY[apiName]++;

  return UrlFetchApp.fetch(url, options || {});
}


/**
 * Clears counts before a new inventory run.
 */
function resetApiInventory() {
  API_CALL_INVENTORY = {};
}


/**
 * Prints the API-call totals to the execution log.
 */
function printApiInventory() {
  let total = 0;

  console.log("========== API CALL INVENTORY ==========");

  Object.keys(API_CALL_INVENTORY)
    .sort()
    .forEach(apiName => {
      const count = API_CALL_INVENTORY[apiName];
      total += count;

      console.log(`${apiName}: ${count}`);
    });

  console.log("----------------------------------------");
  console.log(`TOTAL EXTERNAL API CALLS: ${total}`);
  console.log("========================================");

  return total;
}
/**
 * Fetches and logs all available Gemini models.
 * Note: No 'async/await' needed as UrlFetchApp is synchronous in GAS.
 */
function listAvailableGeminiModels() {
  // 1. Replace with your actual API Key
  const API_KEY = 'YOUR_API_KEY_HERE'; 
  const url = "https://generativelanguage.googleapis.com/v1beta/models?key=" + API_KEY;

  try {
    // In Apps Script, we don't use 'await' for UrlFetchApp
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      contentType: 'application/json',
      muteHttpExceptions: true // Helps see the error message if the API key is wrong
    });

    const responseCode = response.getResponseCode();
    const content = response.getContentText();
    const data = JSON.parse(content);

    if (responseCode === 200) {
      const models = data.models;
      Logger.log("--- Total Models Found: " + models.length + " ---");
      
      models.forEach(model => {
        Logger.log("ID: " + model.name);
        Logger.log("Capabilities: " + model.supportedGenerationMethods.join(", "));
        Logger.log("--------------------------------");
      });
    } else {
      Logger.log("Error " + responseCode + ": " + content);
    }

  } catch (e) {
    Logger.log("Execution Error: " + e.toString());
  }
}
/**
 * Holds global project constants for the project.
 * 
 */

const GEMINI_API_KEY =
  PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
// const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;  //Updated to current version being used...
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;  //Updated to current version being used...

const FIELDS_TO_MAKE_SHEETS_OF = ["radio stations", "name and email", "name and Track and music genre and comments", "name and social media account"];
const STANDARDIZED_HEADERS = 
["First Name", "Last Name", "Email Address", "Phone Number", "Social Media Account",
"Radio Station", "Track Name", "Music Genre", "Rating", "Comments",
"State", "Country", "Region"];

const SPREADSHEET_DATA_EXTRACTION =
  PropertiesService.getScriptProperties()
    .getProperty("SPREADSHEET_DATA_EXTRACTION");

const ISRC_SPREADSHEET =
  PropertiesService.getScriptProperties()
    .getProperty("ISRC_SPREADSHEET");
const PARSER_INPUT_FOLDER =
  PropertiesService.getScriptProperties()
    .getProperty("PARSER_INPUT_FOLDER");

const PARSER_OUTPUT_FOLDER =
  PropertiesService.getScriptProperties()
    .getProperty("PARSER_OUTPUT_FOLDER");

/**
 * Fails fast with an actionable error when a required Script Property is missing.
 * @param {string} name The Script Property key (used in the error message).
 * @param {?string} value The value read from Script Properties.
 * @return {string} The validated value.
 */
function requireScriptProperty(name, value) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required Script Property "${name}". Set it in Project Settings > Script Properties.`);
  }
  return value;
}

//USER_AGENT - used to define the accessing technology for a less likely block of access when scraping websites for data...
// const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const ISRC_REGEX = /[A-Z]{2}-[A-Z0-9]{3}-[0-9]{2}-[0-9]{5}/g;

const PROCESSED_FOLDER = "Processed Reports";
const INPUT_FOLDER = "FileInputFolder"
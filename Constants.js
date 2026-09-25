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

const SPREADSHEET_DATA_EXTRACTION = "1oEJnxzu0AbR9u9MsTbl65Pm1u4LpA1YkVjjviBAf9bk";

const ISRC_SPREADSHEET = "1vx_uwo41rSHUrw2JHemZOe0-NPgnDimafAxaQItMPpE"
//USER_AGENT - used to define the accessing technology for a less likely block of access when scraping websites for data...
// const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const ISRC_REGEX = /[A-Z]{2}-[A-Z0-9]{3}-[0-9]{2}-[0-9]{5}/g;

const PROCESSED_FOLDER = "Processed Reports";
const INPUT_FOLDER = "FileInputFolder"
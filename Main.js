/**
 * Main script to call parsers and data updaters.
 * Triggered by a timer!
 */
function runAutomatedFunctions() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const lastRunStr = scriptProperties.getProperty('LAST_RUN_DATE');
  const today = new Date();
  
  // Set the number of days you want to wait between runs
  const daysInterval = 0; 

  if (lastRunStr) {
    const lastRunDate = new Date(lastRunStr);
    
    // Calculate the difference in time
    const diffInTime = today.getTime() - lastRunDate.getTime();
    const diffInDays = Math.floor(diffInTime / (1000 * 3600 * 24));

    if (diffInDays >= daysInterval) {
      runScripts(); // Call your actual scripts
      
      // Update the last run date to today
      scriptProperties.setProperty('LAST_RUN_DATE', today.toISOString());
      console.log("Interval met. Scripts executed.");
    } else {
      console.log("Only " + diffInDays + " days passed. Waiting for day " + daysInterval);
    }
  } else {
    // First time running: execute and set the property
    runScripts();
    scriptProperties.setProperty('LAST_RUN_DATE', today.toISOString());
    console.log("First run initialized.");
  }
}

/**
 * SCRIPTS TO AUTOMATE HERE!
 * Add in any scripts you want called every x days.
 */
function runScripts() {
  processNewPDFs(); //Go over all input documents!
  //Make sure all the headers are standardized when possible!
  standardizeAndSplitHeaders();

  processISRCMusicMetadata(); 
  //Process all TheOrchard metadata files for ISRC codes and update those without genre/year via MusicBrainz.
  
  findProgramDirectorsWithVerification();
  cleanAndSortAllSheets();  //Remove duplicates and order each sheet alphabetically by the first column.
}

function onEdit(e) {
  processValues();
}

function processValuesManually() {
  processValues();
}

function processValues() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Running Totals");
  if (!sheet) return;
  
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  var dataRange = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  
  for (var i = 0; i < dataRange.length; i++) {
    var row = i + 2;
    var dateValue = dataRange[i][0]; // Column A
    
    if (dateValue !== "" && dateValue !== null) {
      // Ensure proper date parsing
      var date;
      if (typeof dateValue === 'string') {
        // If it's a string like "2025-08-12", parse it correctly
        var parts = dateValue.split('-');
        date = new Date(parts[0], parts[1] - 1, parts[2]); // month is 0-indexed
      } else {
        date = new Date(dateValue);
      }
      
      // Update Day of Week (Column B)
      var dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      var dayOfWeek = date.getDay();
      sheet.getRange(row, 2).setValue(dayNames[dayOfWeek]);
      
      // Update Total (Column E) - ALWAYS calculate if we have values
      var fuel = dataRange[i][2] || 0; // Column C
      var efs = dataRange[i][3] || 0;  // Column D
      
      if (fuel !== 0 || efs !== 0) {
        var total = parseFloat(fuel) + parseFloat(efs);
        sheet.getRange(row, 5).setValue("$ " + total.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
      }
      
      // Update Pay Period (Column F)
      // Find the Tuesday-Monday range containing this date
      var daysToSubtract;
      
      switch(dayOfWeek) {
        case 0: // Sunday - go back 5 days to previous Tuesday
          daysToSubtract = 5;
          break;
        case 1: // Monday - go back 6 days to previous Tuesday  
          daysToSubtract = 6;
          break;
        case 2: // Tuesday - this is the start day
          daysToSubtract = 0;
          break;
        default: // Wed(3) to Sat(6) - go back to this week's Tuesday
          daysToSubtract = dayOfWeek - 2;
      }
      
      var tuesday = new Date(date);
      tuesday.setDate(date.getDate() - daysToSubtract);
      
      var monday = new Date(tuesday);
      monday.setDate(tuesday.getDate() + 6);
      
      var periodString = ("0" + (tuesday.getMonth() + 1)).slice(-2) + "/" + 
                        ("0" + tuesday.getDate()).slice(-2) + " - " +
                        ("0" + (monday.getMonth() + 1)).slice(-2) + "/" + 
                        ("0" + monday.getDate()).slice(-2);
      
      sheet.getRange(row, 6).setValue(periodString);
    }
  }
  
  // Update Weekly Totals tab
  updateWeeklyTotals();
}

function updateWeeklyTotals() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var runningSheet = spreadsheet.getSheetByName("Running Totals");
  var weeklySheet = spreadsheet.getSheetByName("Weekly Totals");
  
  if (!runningSheet || !weeklySheet) return;
  
  // Get all data from Running Totals
  var lastRow = runningSheet.getLastRow();
  if (lastRow < 2) return;
  
  // Get columns C (Fuel), D (EFS), E (Wex), and F (Pay Period)
  var dataRange = runningSheet.getRange(2, 3, lastRow - 1, 4).getValues();
  
  // Create a map to store totals by pay period
  var weeklyTotals = {};
  
  for (var i = 0; i < dataRange.length; i++) {
    var fuel = parseFloat(dataRange[i][0]) || 0;  // Column C
    var efs = parseFloat(dataRange[i][1]) || 0;   // Column D
    var wex = parseFloat(dataRange[i][2]) || 0;   // Column E (Wex Total)
    var payPeriod = dataRange[i][3];              // Column F
    
    if (payPeriod && payPeriod !== "") {
      if (!weeklyTotals[payPeriod]) {
        weeklyTotals[payPeriod] = {
          fuel: 0,
          efs: 0,
          wex: 0
        };
      }
      
      weeklyTotals[payPeriod].fuel += fuel;
      weeklyTotals[payPeriod].efs += efs;
      
      // Parse the Wex Total column if it's formatted as currency
      if (typeof dataRange[i][2] === 'string') {
        var wexValue = dataRange[i][2].replace(/[$,]/g, '').trim();
        wex = parseFloat(wexValue) || 0;
      }
      weeklyTotals[payPeriod].wex += wex;
    }
  }
  
  // Clear existing data in Weekly Totals (except header)
  var weeklyLastRow = weeklySheet.getLastRow();
  if (weeklyLastRow > 1) {
    weeklySheet.getRange(2, 1, weeklyLastRow - 1, 4).clearContent();
  }
  
  // Sort pay periods and write to Weekly Totals
  var periods = Object.keys(weeklyTotals).sort();
  
  if (periods.length > 0) {
    var outputData = [];
    for (var j = 0; j < periods.length; j++) {
      var period = periods[j];
      var totals = weeklyTotals[period];
      
      outputData.push([
        period,
        "$ " + totals.fuel.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","),
        "$ " + totals.efs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","),
        "$ " + totals.wex.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
      ]);
    }
    
    // Write all data at once
    weeklySheet.getRange(2, 1, outputData.length, 4).setValues(outputData);
  }
}

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Custom Scripts')
    .addItem('Process Values', 'processValuesManually')
    .addToUi();
}
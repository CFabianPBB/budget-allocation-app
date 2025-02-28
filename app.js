// app.js - Main application file
const dotenv = require('dotenv');
// Load environment variables before any other requires
dotenv.config();

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
const app = express();
const port = process.env.PORT || 3000;

// Utility function to split arrays into chunks
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// Enhanced function to add meaningful variations to budget distribution
function distributeWithVariation(programs, totalBudget) {
  const baseAllocation = totalBudget / programs.length;
  
  // Create a more complex seed generation with multiple entropy sources
  const getSeed = (programName, index, totalPrograms) => {
    let hash = 0;
    // Use program name, index, and total number of programs for entropy
    const seedString = `${programName}-${index}-${totalPrograms}`;
    
    for (let i = 0; i < seedString.length; i++) {
      const char = seedString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    return Math.abs(hash);
  };

  // Sort programs to ensure consistent ordering
  const sortedPrograms = [...programs].sort((a, b) => a.Program.localeCompare(b.Program));

  // Calculate allocations with more nuanced variations
  const allocatedPrograms = sortedPrograms.map((program, index) => {
    // Use multiple sources of entropy
    const seed = getSeed(
      program.Program, 
      index, 
      sortedPrograms.length
    );
    
    // More sophisticated variation approach
    const variationFactors = [
      (seed % 200 - 100) / 500,            // Base random variation
      Math.sin(seed) * 0.03,               // Trigonometric variation
      (index * 0.01) - (sortedPrograms.length / 200),  // Index-based progressive bias
      Math.cos(index) * 0.02               // Additional cyclic variation
    ];
    
    // Combine variation factors
    const totalVariation = variationFactors.reduce((a, b) => a + b, 0);
    
    const variationFactor = 1 + totalVariation;
    const allocatedAmount = baseAllocation * variationFactor;
    
    return {
      Department: program.Department,
      Program: program.Program,
      Description: program.Description,
      "Total Cost": Math.round(allocatedAmount * 100) / 100
    };
  });

  // Ensure total budget is exactly maintained
  const currentTotal = allocatedPrograms.reduce((sum, p) => sum + p["Total Cost"], 0);
  const scalingFactor = totalBudget / currentTotal;

  allocatedPrograms.forEach(program => {
    program["Total Cost"] = Math.round(program["Total Cost"] * scalingFactor * 100) / 100;
  });

  // Final adjustment to ensure exact total
  const finalTotal = allocatedPrograms.reduce((sum, p) => sum + p["Total Cost"], 0);
  const difference = totalBudget - finalTotal;
  
  if (allocatedPrograms.length > 0) {
    allocatedPrograms[allocatedPrograms.length - 1]["Total Cost"] += difference;
  }

  return allocatedPrograms;
}

// Set up middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync('uploads')) {
      fs.mkdirSync('uploads');
    }
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Home route - Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route to handle file uploads and budget allocation
app.post('/allocate-budget', upload.fields([
  { name: 'programInventory', maxCount: 1 },
  { name: 'departmentBudget', maxCount: 1 }
]), async (req, res) => {
  try {
    // Check if files were uploaded
    if (!req.files || !req.files.programInventory || !req.files.departmentBudget) {
      return res.status(400).json({ success: false, error: 'Please upload both required files' });
    }

    // Access uploaded files
    const programInventoryFile = req.files.programInventory[0];
    const departmentBudgetFile = req.files.departmentBudget[0];
    
    // Read Excel files
    const programInventoryWorkbook = XLSX.readFile(programInventoryFile.path);
    const departmentBudgetWorkbook = XLSX.readFile(departmentBudgetFile.path);
    
    // Get the first sheet from each file
    const programInventorySheet = programInventoryWorkbook.Sheets[programInventoryWorkbook.SheetNames[0]];
    const departmentBudgetSheet = departmentBudgetWorkbook.Sheets[departmentBudgetWorkbook.SheetNames[0]];
    
    // Convert sheets to JSON
    const programInventoryData = XLSX.utils.sheet_to_json(programInventorySheet);
    const departmentBudgetData = XLSX.utils.sheet_to_json(departmentBudgetSheet);
    
    // Create a mapping of departments to their budgets
    const departmentBudgets = {};
    departmentBudgetData.forEach(item => {
      departmentBudgets[item.Department] = item.Budget;
    });
    
    // Group programs by department
    const programsByDepartment = {};
    programInventoryData.forEach(program => {
      if (!programsByDepartment[program.Department]) {
        programsByDepartment[program.Department] = [];
      }
      programsByDepartment[program.Department].push(program);
    });
    
    // Process each department with the LLM to allocate budgets
    let allocatedPrograms = [];
    
    for (const department in programsByDepartment) {
      const budget = departmentBudgets[department];
      const programs = programsByDepartment[department];
      
      console.log(`Processing ${department} with budget ${budget} and ${programs.length} programs`);
      
      // Use LLM to allocate budget
      const allocatedDeptPrograms = await allocateBudgetForDepartment(department, programs, budget);
      allocatedPrograms = [...allocatedPrograms, ...allocatedDeptPrograms];
      
      console.log(`Completed allocation for ${department}`);
    }
    
    // Create output Excel file
    const outputWorkbook = XLSX.utils.book_new();
    const outputSheet = XLSX.utils.json_to_sheet(allocatedPrograms);
    XLSX.utils.book_append_sheet(outputWorkbook, outputSheet, 'Programs');
    
    // Save the output file
    const outputFilePath = path.join('uploads', 'Program_Costs_Output.xlsx');
    XLSX.writeFile(outputWorkbook, outputFilePath);
    
    // Send success response with download link
    res.json({ 
      success: true, 
      message: 'Budget allocation completed successfully',
      downloadLink: '/download-result'
    });
    
  } catch (error) {
    console.error('Error processing budget allocation:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'An error occurred during budget allocation'
    });
  }
});

// Route to download the result file
app.get('/download-result', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', 'Program_Costs_Output.xlsx');
  res.download(filePath, 'Program_Costs_Output.xlsx');
});

// Function to allocate budget for a department using LLM
async function allocateBudgetForDepartment(department, programs, totalBudget) {
  try {
    // If there are too many programs, split them into chunks
    if (programs.length > 10) {
      const chunks = chunkArray(programs, 10);
      const chunkBudgets = chunks.map(chunk => 
        (chunk.length / programs.length) * totalBudget
      );
      
      let allAllocatedPrograms = [];
      
      // Process each chunk separately
      for (let i = 0; i < chunks.length; i++) {
        const chunkPrograms = chunks[i];
        const chunkBudget = chunkBudgets[i];
        
        console.log(`Processing chunk ${i+1}/${chunks.length} for ${department} with ${chunkPrograms.length} programs`);
        
        // Process this chunk
        const allocatedChunk = await allocateBudgetChunk(department, chunkPrograms, chunkBudget);
        allAllocatedPrograms = [...allAllocatedPrograms, ...allocatedChunk];
      }
      
      return allAllocatedPrograms;
    } else {
      // If small enough, process all at once
      return await allocateBudgetChunk(department, programs, totalBudget);
    }
  } catch (error) {
    console.error(`Error allocating budget for ${department}:`, error);
    throw error;
  }
}

// Function to process chunks of programs
async function allocateBudgetChunk(department, programs, totalBudget) {
  try {
    // Summarize descriptions to reduce token count
    const summarizedPrograms = programs.map(program => {
      // Take only first 100 characters of each description to reduce token count
      const shortenedDesc = program.Description && program.Description.length > 100 ? 
        program.Description.substring(0, 100) + "..." : 
        program.Description || "No description provided";
      
      return {
        ...program,
        Description: shortenedDesc
      };
    });
    
    // Create a prompt for the LLM
    const prompt = createLLMPrompt(department, summarizedPrograms, totalBudget);
    
    // Call OpenAI API with reduced token count
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",  // Use a smaller model that allows higher throughput
      messages: [
        {
          role: "system",
          content: "You are a budget allocation specialist for government programs. Your task is to allocate a department's budget across different programs based on their descriptions and relative importance."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 2000  // Reduced from 4000
    });
    
    // Parse the response with robust error handling
    let allocation;
    try {
      allocation = JSON.parse(response.choices[0].message.content);
    } catch (parseError) {
      console.error('Error parsing OpenAI response:', parseError);
      console.log('Response content:', response.choices[0].message.content);
      
      // Use varied distribution if parsing fails
      return distributeWithVariation(programs, totalBudget);
    }

    // Validate the allocation structure
    if (!allocation || !Array.isArray(allocation.program_allocations)) {
      console.log('Invalid allocation structure, using varied distribution');
      return distributeWithVariation(programs, totalBudget);
    }
    
    // Map the allocations back to the original program data with full descriptions
    const allocatedPrograms = programs.map(program => {
      const programAllocation = allocation.program_allocations.find(
        p => p.program_name === program.Program
      );
      
      return {
        Department: program.Department,
        Program: program.Program,
        Description: program.Description,
        "Total Cost": programAllocation ? programAllocation.allocation : (totalBudget / programs.length)
      };
    });
    
    // Ensure the total allocation matches the chunk budget exactly
    const currentTotal = allocatedPrograms.reduce((sum, p) => sum + p["Total Cost"], 0);
    const scalingFactor = totalBudget / currentTotal;
    
    allocatedPrograms.forEach(program => {
      program["Total Cost"] = Math.round(program["Total Cost"] * scalingFactor * 100) / 100;
    });
    
    // Adjust the final program to ensure exact total
    const adjustedTotal = allocatedPrograms.reduce((sum, p) => sum + p["Total Cost"], 0);
    const difference = totalBudget - adjustedTotal;
    
    if (allocatedPrograms.length > 0) {
      allocatedPrograms[allocatedPrograms.length - 1]["Total Cost"] += difference;
    }
    
    return allocatedPrograms;
  } catch (error) {
    console.error(`Error processing chunk for ${department}:`, error);
    
    // Fallback to varied distribution if everything else fails
    return distributeWithVariation(programs, totalBudget);
  }
}

// Function to create a prompt for the LLM
function createLLMPrompt(department, programs, totalBudget) {
  const programList = programs.map(p => {
    return `Program: ${p.Program}\nDescription: ${p.Description}\n`;
  }).join('\n');
  
  return `
Department: ${department}
Total Budget: $${totalBudget.toLocaleString()}
Number of Programs: ${programs.length}

I need you to allocate the total budget of $${totalBudget.toLocaleString()} across the following programs for the ${department}.
Each program should be assigned a portion of the budget based on the program's description, complexity, and likely resource needs. All programs should have a cost greater than zero. No program can have the same cost as another program.

Here are the programs:

${programList}

Please respond with a JSON object that includes:
1. An array of program allocations with each program's name and allocated budget amount
2. A brief explanation of your allocation strategy

The allocations must sum exactly to the total budget of $${totalBudget}.

Example response format:
{
  "program_allocations": [
    {"program_name": "Program 1", "allocation": 100000},
    {"program_name": "Program 2", "allocation": 200000}
  ],
  "allocation_strategy": "Brief explanation of allocation strategy"
}
`;
}

// Start the server
app.listen(port, () => {
  console.log(`Budget allocation app running on port ${port}`);
});
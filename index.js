const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ph-cluster.8kwdmtt.mongodb.net/?retryWrites=true&w=majority&appName=PH-Cluster`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function run() {
  try {
    // await client.connect();
    console.log("Connected to MongoDB");
    
    const db = client.db("earnzyDB");
    const usersCollection = db.collection("users");
    const tasksCollection = db.collection("tasks");

    app.get("/", (req, res) => {
      res.send("Server is running!");
    });

    // Image upload endpoint
    app.post('/upload-image', upload.single('image'), async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }

        // Upload to Cloudinary
        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { resource_type: 'auto' },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          ).end(req.file.buffer);
        });

        res.json({ 
          success: true, 
          imageUrl: result.secure_url,
          publicId: result.public_id
        });
      } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Image upload failed' });
      }
    });

    // Add user registration endpoint
    app.post('/users', async (req, res) => {
      try {
        const { name, email, profilePic, role } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const existing = await usersCollection.findOne({ email });
        if (existing) {
          return res.status(200).json({ message: 'User already exists' });
        }
        let coins = 0;
        if (role === 'worker') coins = 10;
        else if (role === 'buyer') coins = 50;
        else coins = 10; // default for Google sign up
        const user = {
          name,
          email,
          profilePic: profilePic || '',
          role: role || 'worker',
          coins,
          createdAt: new Date(),
        };
        await usersCollection.insertOne(user);
        res.status(201).json({ message: 'User created', user });
      } catch (err) {
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get user data by email
    app.get('/users', async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }
        res.json(user);
      } catch (err) {
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Add task endpoint
    app.post('/tasks', async (req, res) => {
      try {
        const { 
          title, 
          detail, 
          requiredWorkers, 
          payableAmount, 
          completionDate, 
          submissionInfo, 
          imageUrl,
          buyerEmail 
        } = req.body;

        // Validate required fields
        if (!title || !detail || !requiredWorkers || !payableAmount || !completionDate || !buyerEmail) {
          return res.status(400).json({ error: 'All fields are required' });
        }

        // Get buyer info and check coins
        const buyer = await usersCollection.findOne({ email: buyerEmail });
        if (!buyer) {
          return res.status(404).json({ error: 'Buyer not found' });
        }

        const totalPayable = Number(requiredWorkers) * Number(payableAmount);
        if (buyer.coins < totalPayable) {
          return res.status(400).json({ error: 'Insufficient coins' });
        }

        // Create task
        const task = {
          title,
          detail,
          requiredWorkers: Number(requiredWorkers),
          payableAmount: Number(payableAmount),
          completionDate: new Date(completionDate),
          submissionInfo,
          imageUrl: imageUrl || '',
          buyerEmail,
          buyerName: buyer.name,
          totalPayable,
          status: 'active',
          createdAt: new Date(),
          submissions: []
        };

        // Insert task
        const result = await tasksCollection.insertOne(task);

        // Deduct coins from buyer
        await usersCollection.updateOne(
          { email: buyerEmail },
          { $inc: { coins: -totalPayable } }
        );

        res.status(201).json({ 
          message: 'Task created successfully', 
          taskId: result.insertedId,
          remainingCoins: buyer.coins - totalPayable
        });
      } catch (err) {
        console.error('Task creation error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // You can add more routes here...

  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

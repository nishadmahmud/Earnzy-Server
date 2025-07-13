const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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
    const collection = db.collection("users");

    app.get("/", (req, res) => {
      res.send("Server is running!");
    });

    // Add user registration endpoint
    app.post('/users', async (req, res) => {
      try {
        const { name, email, profilePic, role } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const existing = await collection.findOne({ email });
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
        await collection.insertOne(user);
        res.status(201).json({ message: 'User created', user });
      } catch (err) {
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

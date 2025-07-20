const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Initialize Stripe after loading environment variables
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

// Configure nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
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
    const submissionsCollection = db.collection("submissions");
    const notificationsCollection = db.collection("notifications");
    const withdrawalsCollection = db.collection("withdrawals");

    // Helper function to create notifications
    const createNotification = async (message, toEmail, actionRoute) => {
      try {
        const notification = {
          message,
          toEmail,
          actionRoute,
          time: new Date(),
          read: false
        };
        await notificationsCollection.insertOne(notification);
      } catch (error) {
        console.error('Error creating notification:', error);
      }
    };

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

    // Get available tasks for workers
    app.get('/tasks/available', async (req, res) => {
      try {
        const { workerEmail } = req.query;
        
        // Get all active tasks where required_workers > 0
        const availableTasks = await tasksCollection.find({
          status: 'active',
          requiredWorkers: { $gt: 0 }
        }).sort({ createdAt: -1 }).toArray();

        // If workerEmail is provided, check submission status for each task
        let formattedTasks = availableTasks;
        if (workerEmail) {
          // Get all submissions by this worker
          const workerSubmissions = await submissionsCollection.find({
            workerEmail: workerEmail
          }).toArray();
          
          // Create maps for different submission statuses
          const submittedTaskIds = new Set();
          const completedTaskIds = new Set();
          
          workerSubmissions.forEach(submission => {
            const taskId = submission.taskId.toString();
            if (submission.status === 'approved') {
              completedTaskIds.add(taskId);
            } else if (submission.status === 'pending' || submission.status === 'rejected') {
              submittedTaskIds.add(taskId);
            }
          });

          // Format tasks and add submission status
          formattedTasks = availableTasks.map(task => ({
            ...task,
            completionDate: task.completionDate.toISOString().split('T')[0], // Format as YYYY-MM-DD
            hasSubmitted: submittedTaskIds.has(task._id.toString()),
            isCompleted: completedTaskIds.has(task._id.toString())
          }));
        } else {
          // Format completion date for frontend (no submission status)
          formattedTasks = availableTasks.map(task => ({
            ...task,
            completionDate: task.completionDate.toISOString().split('T')[0] // Format as YYYY-MM-DD
          }));
        }

        res.json(formattedTasks);
      } catch (err) {
        console.error('Get available tasks error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get task details by ID
    app.get('/tasks/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { workerEmail } = req.query;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid task ID' });
        }

        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        // Format completion date for frontend
        let formattedTask = {
          ...task,
          completionDate: task.completionDate.toISOString().split('T')[0]
        };

        // If workerEmail is provided, check submission status
        if (workerEmail) {
          const workerSubmission = await submissionsCollection.findOne({
            taskId: new ObjectId(id),
            workerEmail: workerEmail
          });

          if (workerSubmission) {
            formattedTask.hasSubmitted = true;
            formattedTask.isCompleted = workerSubmission.status === 'approved';
            formattedTask.submissionStatus = workerSubmission.status;
          } else {
            formattedTask.hasSubmitted = false;
            formattedTask.isCompleted = false;
            formattedTask.submissionStatus = null;
          }
        }

        res.json(formattedTask);
      } catch (err) {
        console.error('Get task details error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get worker submissions
    app.get('/worker/submissions', async (req, res) => {
      try {
        const { workerEmail } = req.query;

        if (!workerEmail) {
          return res.status(400).json({ error: 'Worker email is required' });
        }

        // Get all submissions for the worker
        const submissions = await submissionsCollection.find({
          workerEmail: workerEmail
        }).sort({ submittedAt: -1 }).toArray();

        // Format dates for frontend
        const formattedSubmissions = submissions.map(submission => ({
          ...submission,
          submissionDate: submission.submittedAt.toISOString().split('T')[0], // Format as YYYY-MM-DD
          submittedAt: submission.submittedAt.toISOString()
        }));

        res.json(formattedSubmissions);
      } catch (err) {
        console.error('Get worker submissions error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Create withdrawal request
    app.post('/worker/withdraw', async (req, res) => {
      try {
        const { workerEmail, workerName, withdrawalCoin, withdrawalAmount, paymentSystem, accountNumber } = req.body;

        if (!workerEmail || !workerName || !withdrawalCoin || !withdrawalAmount || !paymentSystem || !accountNumber) {
          return res.status(400).json({ error: 'All fields are required' });
        }

        // Validate withdrawal amount (20 coins = 1 dollar)
        const expectedAmount = withdrawalCoin / 20;
        if (Math.abs(withdrawalAmount - expectedAmount) > 0.01) {
          return res.status(400).json({ error: 'Invalid withdrawal amount calculation' });
        }

        // Check if user has enough coins
        const user = await usersCollection.findOne({ email: workerEmail });
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        if (user.coins < withdrawalCoin) {
          return res.status(400).json({ error: 'Insufficient coins' });
        }

        // Check minimum withdrawal (200 coins = 10 dollars)
        if (withdrawalCoin < 200) {
          return res.status(400).json({ error: 'Minimum withdrawal is 200 coins ($10)' });
        }

        // Create withdrawal request
        const withdrawal = {
          workerEmail,
          workerName,
          withdrawalCoin,
          withdrawalAmount,
          paymentSystem,
          accountNumber,
          withdrawDate: new Date(),
          status: 'pending'
        };

        const result = await withdrawalsCollection.insertOne(withdrawal);

        // Deduct coins from user account
        await usersCollection.updateOne(
          { email: workerEmail },
          { $inc: { coins: -withdrawalCoin } }
        );

        // Create notification for user
        await createNotification(
          `Your withdrawal request of ${withdrawalCoin} coins ($${withdrawalAmount}) has been submitted and is pending approval.`,
          workerEmail,
          '/dashboard/withdrawals'
        );

        res.status(201).json({
          message: 'Withdrawal request submitted successfully',
          withdrawalId: result.insertedId
        });
      } catch (err) {
        console.error('Create withdrawal error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get worker withdrawals
    app.get('/worker/withdrawals', async (req, res) => {
      try {
        const { workerEmail } = req.query;

        if (!workerEmail) {
          return res.status(400).json({ error: 'Worker email is required' });
        }

        // Get all withdrawals for the worker
        const withdrawals = await withdrawalsCollection.find({
          workerEmail: workerEmail
        }).sort({ withdrawDate: -1 }).toArray();

        // Format dates for frontend
        const formattedWithdrawals = withdrawals.map(withdrawal => ({
          ...withdrawal,
          withdrawalDate: withdrawal.withdrawDate.toISOString().split('T')[0], // Format as YYYY-MM-DD
          withdrawDate: withdrawal.withdrawDate.toISOString()
        }));

        res.json(formattedWithdrawals);
      } catch (err) {
        console.error('Get worker withdrawals error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Admin dashboard stats
    app.get('/admin/dashboard', async (req, res) => {
      try {
        // Get total workers (users with role 'worker')
        const totalWorkers = await usersCollection.countDocuments({ role: 'worker' });
        
        // Get total buyers (users with role 'buyer')
        const totalBuyers = await usersCollection.countDocuments({ role: 'buyer' });
        
        // Get total available coins (sum of all users' coins)
        const coinAggregation = await usersCollection.aggregate([
          { $group: { _id: null, totalCoins: { $sum: '$coins' } } }
        ]).toArray();
        const totalAvailableCoins = coinAggregation.length > 0 ? coinAggregation[0].totalCoins : 0;
        
        // Get total payments (you might want to adjust this based on your payment collection)
        // For now, assuming we count successful coin purchases
        const totalPayments = await usersCollection.aggregate([
          { $group: { _id: null, totalPayments: { $sum: '$totalPurchased' } } }
        ]).toArray();
        const totalPaymentAmount = totalPayments.length > 0 ? totalPayments[0].totalPayments : 0;

        res.json({
          totalWorkers,
          totalBuyers,
          totalAvailableCoins,
          totalPayments: totalPaymentAmount || 0
        });
      } catch (err) {
        console.error('Admin dashboard error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get pending withdrawal requests
    app.get('/admin/withdrawals/pending', async (req, res) => {
      try {
        const pendingWithdrawals = await withdrawalsCollection.find({
          status: 'pending'
        }).sort({ withdrawDate: -1 }).toArray();

        // Format dates for frontend
        const formattedWithdrawals = pendingWithdrawals.map(withdrawal => ({
          ...withdrawal,
          withdrawalDate: withdrawal.withdrawDate.toISOString().split('T')[0],
          withdrawDate: withdrawal.withdrawDate.toISOString()
        }));

        res.json(formattedWithdrawals);
      } catch (err) {
        console.error('Get pending withdrawals error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Approve withdrawal request
    app.put('/admin/withdrawals/:id/approve', async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid withdrawal ID' });
        }

        // Get the withdrawal request
        const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(id) });
        if (!withdrawal) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        if (withdrawal.status !== 'pending') {
          return res.status(400).json({ error: 'Withdrawal request is not pending' });
        }

        // Update withdrawal status to approved
        await withdrawalsCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              status: 'approved',
              approvedAt: new Date()
            } 
          }
        );

        // Note: Coins were already deducted when the withdrawal was created
        // Create notification for user
        await createNotification(
          `Your withdrawal request of ${withdrawal.withdrawalCoin} coins ($${withdrawal.withdrawalAmount}) has been approved and processed.`,
          withdrawal.workerEmail,
          '/dashboard/withdrawals'
        );

        res.json({ message: 'Withdrawal request approved successfully' });
      } catch (err) {
        console.error('Approve withdrawal error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get all users for admin management
    app.get('/admin/users', async (req, res) => {
      try {
        const users = await usersCollection.find({}).sort({ createdAt: -1 }).toArray();
        
        // Format user data for frontend
        const formattedUsers = users.map(user => ({
          _id: user._id,
          name: user.name || user.displayName || user.email.split('@')[0],
          email: user.email,
          photoURL: user.photoURL || user.profilePic || null,
          role: user.role || 'worker',
          coins: user.coins || 0,
          createdAt: user.createdAt
        }));

        res.json(formattedUsers);
      } catch (err) {
        console.error('Get all users error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Update user role
    app.put('/admin/users/:email/role', async (req, res) => {
      try {
        const { email } = req.params;
        const { role } = req.body;

        if (!email || !role) {
          return res.status(400).json({ error: 'Email and role are required' });
        }

        if (!['admin', 'buyer', 'worker'].includes(role)) {
          return res.status(400).json({ error: 'Invalid role. Must be admin, buyer, or worker' });
        }

        // Update user role
        const result = await usersCollection.updateOne(
          { email: email },
          { $set: { role: role } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: 'User not found' });
        }

        // Create notification for user
        await createNotification(
          `Your account role has been updated to ${role} by an administrator.`,
          email,
          '/dashboard'
        );

        res.json({ message: 'User role updated successfully' });
      } catch (err) {
        console.error('Update user role error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Delete user
    app.delete('/admin/users/:email', async (req, res) => {
      try {
        const { email } = req.params;

        if (!email) {
          return res.status(400).json({ error: 'Email is required' });
        }

        // Check if user exists
        const user = await usersCollection.findOne({ email: email });
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        // Delete user from database
        await usersCollection.deleteOne({ email: email });

        // Also delete related data
        await submissionsCollection.deleteMany({ workerEmail: email });
        await submissionsCollection.deleteMany({ buyerEmail: email });
        await tasksCollection.deleteMany({ buyerEmail: email });
        await withdrawalsCollection.deleteMany({ workerEmail: email });
        await notificationsCollection.deleteMany({ toEmail: email });

        res.json({ message: 'User deleted successfully' });
      } catch (err) {
        console.error('Delete user error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get all tasks for admin management
    app.get('/admin/tasks', async (req, res) => {
      try {
        const tasks = await tasksCollection.find({}).sort({ createdAt: -1 }).toArray();
        
        // Format task data for frontend
        const formattedTasks = tasks.map(task => ({
          ...task,
          completionDate: task.completionDate ? task.completionDate.toISOString().split('T')[0] : null,
          createdAt: task.createdAt ? task.createdAt.toISOString() : null
        }));

        res.json(formattedTasks);
      } catch (err) {
        console.error('Get all tasks error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Delete task
    app.delete('/admin/tasks/:id', async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid task ID' });
        }

        // Check if task exists
        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        // Delete task from database
        await tasksCollection.deleteOne({ _id: new ObjectId(id) });

        // Also delete related submissions for this task
        await submissionsCollection.deleteMany({ taskId: new ObjectId(id) });

        // Create notification for the task buyer
        await createNotification(
          `Your task "${task.title}" has been deleted by an administrator.`,
          task.buyerEmail,
          '/dashboard'
        );

        res.json({ message: 'Task deleted successfully' });
      } catch (err) {
        console.error('Delete task error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get top workers for home page
    app.get('/top-workers', async (req, res) => {
      try {
        // Get top 6 workers (show all workers, not just those with coins > 0)
        const topWorkers = await usersCollection.find({
          role: 'worker'
        }).sort({ coins: -1 }).limit(6).toArray();

        console.log('Found workers:', topWorkers.length);
        console.log('Workers data:', topWorkers.map(w => ({ name: w.name || w.displayName || w.email, coins: w.coins || 0 })));

        // Format worker data for frontend
        const formattedWorkers = topWorkers.map(worker => ({
          _id: worker._id,
          name: worker.name || worker.displayName || worker.email.split('@')[0],
          email: worker.email,
          photoURL: worker.photoURL || worker.profilePic || null,
          coins: worker.coins || 0
        }));

        res.json(formattedWorkers);
      } catch (err) {
        console.error('Get top workers error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Worker dashboard endpoint
    app.get('/worker/dashboard', async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        // Get worker info
        const worker = await usersCollection.findOne({ email });
        if (!worker) {
          return res.status(404).json({ error: 'Worker not found' });
        }

        // Get all submissions by worker
        const allSubmissions = await submissionsCollection.find({ workerEmail: email }).toArray();
        
        // Get pending submissions
        const pendingSubmissions = allSubmissions.filter(sub => sub.status === 'pending');
        
        // Get approved submissions with task details
        const approvedSubmissions = allSubmissions.filter(sub => sub.status === 'approved');
        
        // Get task details for approved submissions
        const approvedSubmissionsWithDetails = await Promise.all(
          approvedSubmissions.map(async (submission) => {
            const task = await tasksCollection.findOne({ _id: submission.taskId });
            return {
              ...submission,
              task_title: task?.title || 'Unknown Task',
              payable_amount: task?.payableAmount || 0,
              buyer_name: task?.buyerName || 'Unknown Buyer',
              submittedAt: submission.submittedAt,
              approvedAt: submission.approvedAt
            };
          })
        );

        // Calculate total earnings (sum of approved submissions)
        const totalEarnings = approvedSubmissionsWithDetails.reduce((sum, sub) => sum + sub.payable_amount, 0);

        // Calculate stats
        const stats = {
          totalSubmissions: allSubmissions.length,
          pendingSubmissions: pendingSubmissions.length,
          totalEarnings: totalEarnings
        };

        res.json({
          stats,
          approvedSubmissions: approvedSubmissionsWithDetails.sort((a, b) => new Date(b.approvedAt) - new Date(a.approvedAt))
        });
      } catch (err) {
        console.error('Worker dashboard error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Buyer dashboard endpoint
    app.get('/buyer/dashboard', async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        // Get buyer info
        const buyer = await usersCollection.findOne({ email });
        if (!buyer) {
          return res.status(404).json({ error: 'Buyer not found' });
        }

        // Get buyer's tasks
        const tasks = await tasksCollection.find({ buyerEmail: email }).toArray();
        
        // Calculate stats according to requirements:
        // 1. Total task count (tasks added by user)
        const totalTasks = tasks.length;
        
        // 2. Pending tasks (sum of all required_workers count of his added tasks)
        const pendingTasks = tasks.reduce((sum, task) => sum + (task.requiredWorkers || 0), 0);
        
        // 3. Total payments paid by the user (sum of totalPayable for all tasks)
        const totalPayments = tasks.reduce((sum, task) => sum + (task.totalPayable || 0), 0);
        
        // Get pending submissions for buyer's tasks
        const taskIds = tasks.map(task => task._id);
        const pendingSubmissions = await submissionsCollection.find({
          taskId: { $in: taskIds },
          status: 'pending'
        }).toArray();

        // Get worker details for submissions
        const submissionsWithDetails = await Promise.all(
          pendingSubmissions.map(async (submission) => {
            const worker = await usersCollection.findOne({ email: submission.workerEmail });
            const task = tasks.find(t => t._id.toString() === submission.taskId.toString());
            
            return {
              ...submission,
              worker: {
                name: worker?.name || worker?.displayName || 'Unknown',
                email: worker?.email || '',
                profilePic: worker?.profilePic || worker?.photoURL || ''
              },
              task: {
                title: task?.title || 'Unknown Task',
                description: task?.detail || ''
              },
              payableAmount: task?.payableAmount || 0
            };
          })
        );

        res.json({
          stats: {
            totalTasks,
            pendingWorkers: pendingTasks, // This is the sum of required_workers
            totalPayments
          },
          pendingSubmissions: submissionsWithDetails
        });
      } catch (err) {
        console.error('Buyer dashboard error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Approve submission endpoint
    app.put('/submissions/:id/approve', async (req, res) => {
      try {
        const { id } = req.params;
        const { buyerEmail } = req.body;

        if (!buyerEmail) {
          return res.status(400).json({ error: 'Buyer email is required' });
        }

        // Get submission
        const submission = await submissionsCollection.findOne({ _id: new ObjectId(id) });
        if (!submission) {
          return res.status(404).json({ error: 'Submission not found' });
        }

        // Get task to verify ownership and get payment amount
        const task = await tasksCollection.findOne({ _id: submission.taskId });
        if (!task || task.buyerEmail !== buyerEmail) {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        // Update submission status
        await submissionsCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              status: 'approved',
              approvedAt: new Date()
            }
          }
        );

        // Add coins to worker
        await usersCollection.updateOne(
          { email: submission.workerEmail },
          { $inc: { coins: task.payableAmount } }
        );

        // Get buyer info for notification
        const buyer = await usersCollection.findOne({ email: buyerEmail });
        const buyerName = buyer?.name || 'Unknown Buyer';

        // Create notification for worker
        await createNotification(
          `You have earned ${task.payableAmount} coins from ${buyerName} for completing "${task.title}"`,
          submission.workerEmail,
          '/dashboard'
        );

        res.json({ message: 'Submission approved successfully' });
      } catch (err) {
        console.error('Approve submission error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Reject submission endpoint
    app.put('/submissions/:id/reject', async (req, res) => {
      try {
        const { id } = req.params;
        const { buyerEmail } = req.body;

        if (!buyerEmail) {
          return res.status(400).json({ error: 'Buyer email is required' });
        }

        // Get submission
        const submission = await submissionsCollection.findOne({ _id: new ObjectId(id) });
        if (!submission) {
          return res.status(404).json({ error: 'Submission not found' });
        }

        // Get task to verify ownership
        const task = await tasksCollection.findOne({ _id: submission.taskId });
        if (!task || task.buyerEmail !== buyerEmail) {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        // Update submission status
        await submissionsCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              status: 'rejected',
              rejectedAt: new Date()
            }
          }
        );

        // Increase required_workers by 1 (as per requirements)
        await tasksCollection.updateOne(
          { _id: submission.taskId },
          { $inc: { requiredWorkers: 1 } }
        );

        // Get buyer info for notification
        const buyer = await usersCollection.findOne({ email: buyerEmail });
        const buyerName = buyer?.name || 'Unknown Buyer';

        // Create notification for worker
        await createNotification(
          `Your submission for "${task.title}" has been rejected by ${buyerName}. Please review and resubmit if needed.`,
          submission.workerEmail,
          '/dashboard/submissions'
        );

        res.json({ message: 'Submission rejected successfully' });
      } catch (err) {
        console.error('Reject submission error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Create submission endpoint
    app.post('/submissions', async (req, res) => {
      try {
        const { taskId, workerEmail, submissionDetails } = req.body;

        if (!taskId || !workerEmail || !submissionDetails) {
          return res.status(400).json({ error: 'Task ID, worker email, and submission details are required' });
        }

        // Verify task exists
        const task = await tasksCollection.findOne({ _id: new ObjectId(taskId) });
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        // Get worker info
        const worker = await usersCollection.findOne({ email: workerEmail });
        if (!worker) {
          return res.status(404).json({ error: 'Worker not found' });
        }

        // Check if worker has already submitted for this task
        const existingSubmission = await submissionsCollection.findOne({
          taskId: new ObjectId(taskId),
          workerEmail: workerEmail
        });

        if (existingSubmission) {
          return res.status(400).json({ error: 'You have already submitted for this task' });
        }

        // Create submission with all required fields
        const submission = {
          taskId: new ObjectId(taskId),
          taskTitle: task.title,
          payableAmount: task.payableAmount,
          workerEmail,
          workerName: worker.name,
          buyerName: task.buyerName,
          buyerEmail: task.buyerEmail,
          submissionDetails,
          status: 'pending',
          submittedAt: new Date()
        };

        const result = await submissionsCollection.insertOne(submission);

        // Create notification for buyer
        await createNotification(
          `${worker.name} has submitted work for your task "${task.title}". Please review and approve/reject the submission.`,
          task.buyerEmail,
          '/dashboard'
        );

        res.status(201).json({
          message: 'Submission created successfully',
          submissionId: result.insertedId
        });
      } catch (err) {
        console.error('Create submission error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Create sample submission data (for testing)
    app.post('/create-sample-data', async (req, res) => {
      try {
        // Get first task and create sample submissions
        const task = await tasksCollection.findOne({ status: 'active' });
        if (!task) {
          return res.status(404).json({ error: 'No active tasks found' });
        }

        // Create sample workers if they don't exist
        const sampleWorkers = [
          {
            name: 'John Doe',
            email: 'john.worker@example.com',
            profilePic: 'https://ui-avatars.com/api/?name=John+Doe',
            role: 'worker',
            coins: 25,
            createdAt: new Date()
          },
          {
            name: 'Jane Smith',
            email: 'jane.worker@example.com',
            profilePic: 'https://ui-avatars.com/api/?name=Jane+Smith',
            role: 'worker',
            coins: 15,
            createdAt: new Date()
          }
        ];

        // Insert workers if they don't exist
        for (const worker of sampleWorkers) {
          const existingWorker = await usersCollection.findOne({ email: worker.email });
          if (!existingWorker) {
            await usersCollection.insertOne(worker);
          }
        }

        // Create sample submissions
        const sampleSubmissions = [
          {
            taskId: task._id,
            workerEmail: 'john.worker@example.com',
            submissionText: 'I have completed the task as requested. Here is my submission with detailed explanation of the work done.',
            attachments: [
              {
                name: 'screenshot.png',
                url: 'https://example.com/screenshot.png'
              }
            ],
            status: 'pending',
            submittedAt: new Date()
          },
          {
            taskId: task._id,
            workerEmail: 'jane.worker@example.com',
            submissionText: 'Task completed successfully. I have followed all the instructions and provided the required proof.',
            attachments: [
              {
                name: 'proof.jpg',
                url: 'https://example.com/proof.jpg'
              }
            ],
            status: 'pending',
            submittedAt: new Date()
          }
        ];

        // Insert submissions
        await submissionsCollection.insertMany(sampleSubmissions);

        res.json({ message: 'Sample data created successfully' });
      } catch (err) {
        console.error('Create sample data error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get tasks by buyer email
    app.get('/tasks', async (req, res) => {
      try {
        const { buyer } = req.query;
        if (!buyer) return res.status(400).json({ error: 'Buyer email is required' });

        const tasks = await tasksCollection.find({ buyerEmail: buyer }).toArray();
        
        // Format dates for frontend
        const formattedTasks = tasks.map(task => ({
          ...task,
          completionDate: task.completionDate.toISOString().split('T')[0] // Format as YYYY-MM-DD
        }));

        res.json(formattedTasks);
      } catch (err) {
        console.error('Get tasks error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Update task
    app.put('/tasks/:id', async (req, res) => {
      try {
        const { id } = req.params;
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

        console.log('Update task request:', { id, title, detail, requiredWorkers, payableAmount, completionDate, submissionInfo, imageUrl, buyerEmail });

        // Validate ObjectId format
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid task ID format' });
        }

        if (!title || !detail || !requiredWorkers || !payableAmount || !completionDate || !submissionInfo || !buyerEmail) {
          return res.status(400).json({ error: 'All fields are required' });
        }

        // Validate numeric fields
        if (isNaN(requiredWorkers) || isNaN(payableAmount) || Number(requiredWorkers) <= 0 || Number(payableAmount) <= 0) {
          return res.status(400).json({ error: 'Required workers and payable amount must be positive numbers' });
        }

        // Validate date
        const parsedDate = new Date(completionDate);
        if (isNaN(parsedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid completion date' });
        }

        // Verify task ownership
        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        if (task.buyerEmail !== buyerEmail) {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        // Check if payment amount changed and handle coin adjustment
        const oldTotalPayable = task.totalPayable || 0;
        const newTotalPayable = Number(requiredWorkers) * Number(payableAmount);
        const coinDifference = newTotalPayable - oldTotalPayable;

        console.log('Payment calculation:', { oldTotalPayable, newTotalPayable, coinDifference });

        // If payment increased, check if buyer has enough coins
        if (coinDifference > 0) {
          const buyer = await usersCollection.findOne({ email: buyerEmail });
          if (!buyer || buyer.coins < coinDifference) {
            return res.status(400).json({ error: 'Insufficient coins for increased payment' });
          }
        }

        // Update task
        const updateResult = await tasksCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              title,
              detail,
              requiredWorkers: Number(requiredWorkers),
              payableAmount: Number(payableAmount),
              completionDate: parsedDate,
              submissionInfo,
              imageUrl: imageUrl || '',
              totalPayable: newTotalPayable,
              updatedAt: new Date()
            }
          }
        );

        console.log('Task update result:', updateResult);

        // Adjust buyer's coins if payment amount changed
        if (coinDifference !== 0) {
          const coinUpdateResult = await usersCollection.updateOne(
            { email: buyerEmail },
            { $inc: { coins: -coinDifference } }
          );
          console.log('Coin update result:', coinUpdateResult);
        }

        // Get updated user coins
        const updatedUser = await usersCollection.findOne({ email: buyerEmail });

        res.json({ 
          message: 'Task updated successfully',
          coinDifference,
          remainingCoins: updatedUser.coins
        });
      } catch (err) {
        console.error('Update task error:', err);
        console.error('Error stack:', err.stack);
        res.status(500).json({ error: 'Server error: ' + err.message });
      }
    });

    // Delete task
    app.delete('/tasks/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { buyerEmail } = req.body;

        if (!buyerEmail) {
          return res.status(400).json({ error: 'Buyer email is required' });
        }

        // Get task to verify ownership and calculate refund
        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        if (task.buyerEmail !== buyerEmail) {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        // Check if task has approved submissions (shouldn't refund if work is done)
        const approvedSubmissions = await submissionsCollection.countDocuments({
          taskId: new ObjectId(id),
          status: 'approved'
        });

        // Calculate refund amount (total - approved submissions)
        const refundAmount = (task.requiredWorkers - approvedSubmissions) * task.payableAmount;

        // Delete task
        await tasksCollection.deleteOne({ _id: new ObjectId(id) });

        // Delete related submissions
        await submissionsCollection.deleteMany({ taskId: new ObjectId(id) });

        // Refund coins if there are any to refund
        if (refundAmount > 0) {
          await usersCollection.updateOne(
            { email: buyerEmail },
            { $inc: { coins: refundAmount } }
          );
        }

        // Get updated user coins
        const updatedUser = await usersCollection.findOne({ email: buyerEmail });

        res.json({ 
          message: 'Task deleted successfully',
          refundAmount,
          remainingCoins: updatedUser.coins
        });
      } catch (err) {
        console.error('Delete task error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Stripe Payment Endpoints
    
    // Create payment intent
    app.post('/create-payment-intent', async (req, res) => {
      try {
        const { amount, coins, userEmail } = req.body;
        
        // Validate input
        if (!amount || !coins || !userEmail) {
          return res.status(400).json({ error: 'Missing required fields' });
        }

        // Create payment intent
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // Convert to cents
          currency: 'usd',
          automatic_payment_methods: {
            enabled: true,
          },
          metadata: {
            userEmail,
            coins: coins.toString(),
          },
        });

        res.json({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
        });
      } catch (err) {
        console.error('Create payment intent error:', err);
        res.status(500).json({ error: 'Failed to create payment intent' });
      }
    });

    // Confirm payment and update user coins
    app.post('/confirm-payment', async (req, res) => {
      try {
        const { paymentIntentId } = req.body;
        
        if (!paymentIntentId) {
          return res.status(400).json({ error: 'Payment intent ID is required' });
        }

        // Retrieve payment intent from Stripe
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        if (paymentIntent.status !== 'succeeded') {
          return res.status(400).json({ error: 'Payment not successful' });
        }

        const { userEmail, coins } = paymentIntent.metadata;
        const coinsToAdd = parseInt(coins);

        // Update user coins in database
        const result = await usersCollection.updateOne(
          { email: userEmail },
          { $inc: { coins: coinsToAdd } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: 'User not found' });
        }

        // Get updated user data
        const updatedUser = await usersCollection.findOne({ email: userEmail });

        // Create notification for coin purchase
        await createNotification(
          `You have successfully purchased ${coinsToAdd} coins for $${(paymentIntent.amount / 100).toFixed(2)}. Your current balance is ${updatedUser.coins} coins.`,
          userEmail,
          '/dashboard/purchase-coin'
        );

        // Send confirmation email
        try {
          await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: userEmail,
            subject: 'Earnzy - Coin Purchase Confirmation',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #2563eb;">Payment Successful!</h2>
                <p>Dear User,</p>
                <p>Your coin purchase has been successfully processed.</p>
                <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                  <h3 style="margin: 0 0 10px 0;">Purchase Details:</h3>
                  <p><strong>Coins Purchased:</strong> ${coinsToAdd}</p>
                  <p><strong>Amount Paid:</strong> $${(paymentIntent.amount / 100).toFixed(2)}</p>
                  <p><strong>Current Balance:</strong> ${updatedUser.coins} coins</p>
                </div>
                <p>Thank you for using Earnzy!</p>
                <p>Best regards,<br>The Earnzy Team</p>
              </div>
            `
          });
        } catch (emailErr) {
          console.error('Email sending error:', emailErr);
          // Don't fail the request if email fails
        }

        res.json({
          success: true,
          message: 'Payment confirmed and coins added',
          coins: updatedUser.coins,
          coinsAdded: coinsToAdd
        });
      } catch (err) {
        console.error('Confirm payment error:', err);
        res.status(500).json({ error: 'Failed to confirm payment' });
      }
    });

    // Get payment history
    app.get('/payment-history', async (req, res) => {
      try {
        const { email } = req.query;
        
        if (!email) {
          return res.status(400).json({ error: 'Email is required' });
        }

        // Get payment history from Stripe
        const paymentIntents = await stripe.paymentIntents.list({
          limit: 50,
        });

        // Filter payments for this user
        const userPayments = paymentIntents.data
          .filter(pi => pi.metadata.userEmail === email && pi.status === 'succeeded')
          .map(pi => ({
            id: pi.id,
            amount: pi.amount / 100,
            coins: parseInt(pi.metadata.coins),
            date: new Date(pi.created * 1000),
            status: pi.status
          }))
          .sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json(userPayments);
      } catch (err) {
        console.error('Payment history error:', err);
        res.status(500).json({ error: 'Failed to fetch payment history' });
      }
    });

    // Withdrawal endpoints
    
    // Create withdrawal request
    app.post('/withdrawals', async (req, res) => {
      try {
        const { workerEmail, amount, paymentSystem, accountNumber } = req.body;

        if (!workerEmail || !amount || !paymentSystem || !accountNumber) {
          return res.status(400).json({ error: 'All fields are required' });
        }

        // Get worker info
        const worker = await usersCollection.findOne({ email: workerEmail });
        if (!worker) {
          return res.status(404).json({ error: 'Worker not found' });
        }

        // Check if worker has enough coins
        const COIN_TO_DOLLAR = 20;
        const requiredCoins = amount * COIN_TO_DOLLAR;
        if (worker.coins < requiredCoins) {
          return res.status(400).json({ error: 'Insufficient coins for withdrawal' });
        }

        // Create withdrawal request
        const withdrawal = {
          workerEmail,
          workerName: worker.name,
          amount: Number(amount),
          paymentSystem,
          accountNumber,
          status: 'pending',
          requestedAt: new Date()
        };

        const result = await withdrawalsCollection.insertOne(withdrawal);

        // Deduct coins from worker
        await usersCollection.updateOne(
          { email: workerEmail },
          { $inc: { coins: -requiredCoins } }
        );

        res.status(201).json({
          message: 'Withdrawal request submitted successfully',
          withdrawalId: result.insertedId
        });
      } catch (err) {
        console.error('Create withdrawal error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Get withdrawal requests (for admin)
    app.get('/withdrawals', async (req, res) => {
      try {
        const { status } = req.query;
        
        const query = status ? { status } : {};
        const withdrawals = await withdrawalsCollection
          .find(query)
          .sort({ requestedAt: -1 })
          .toArray();

        res.json(withdrawals);
      } catch (err) {
        console.error('Get withdrawals error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Approve withdrawal request
    app.put('/withdrawals/:id/approve', async (req, res) => {
      try {
        const { id } = req.params;
        const { adminEmail } = req.body;

        if (!adminEmail) {
          return res.status(400).json({ error: 'Admin email is required' });
        }

        // Verify admin
        const admin = await usersCollection.findOne({ email: adminEmail });
        if (!admin || admin.role !== 'admin') {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        // Get withdrawal request
        const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(id) });
        if (!withdrawal) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        if (withdrawal.status !== 'pending') {
          return res.status(400).json({ error: 'Withdrawal request already processed' });
        }

        // Update withdrawal status
        await withdrawalsCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              status: 'approved',
              approvedAt: new Date(),
              approvedBy: adminEmail
            }
          }
        );

        // Create notification for worker
        await createNotification(
          `Your withdrawal request of $${withdrawal.amount} has been approved and processed. The amount will be sent to your ${withdrawal.paymentSystem} account.`,
          withdrawal.workerEmail,
          '/dashboard/withdrawals'
        );

        res.json({ message: 'Withdrawal request approved successfully' });
      } catch (err) {
        console.error('Approve withdrawal error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Reject withdrawal request
    app.put('/withdrawals/:id/reject', async (req, res) => {
      try {
        const { id } = req.params;
        const { adminEmail, reason } = req.body;

        if (!adminEmail) {
          return res.status(400).json({ error: 'Admin email is required' });
        }

        // Verify admin
        const admin = await usersCollection.findOne({ email: adminEmail });
        if (!admin || admin.role !== 'admin') {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        // Get withdrawal request
        const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(id) });
        if (!withdrawal) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        if (withdrawal.status !== 'pending') {
          return res.status(400).json({ error: 'Withdrawal request already processed' });
        }

        // Update withdrawal status
        await withdrawalsCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              status: 'rejected',
              rejectedAt: new Date(),
              rejectedBy: adminEmail,
              rejectionReason: reason || 'No reason provided'
            }
          }
        );

        // Refund coins to worker
        const COIN_TO_DOLLAR = 20;
        const refundCoins = withdrawal.amount * COIN_TO_DOLLAR;
        await usersCollection.updateOne(
          { email: withdrawal.workerEmail },
          { $inc: { coins: refundCoins } }
        );

        // Create notification for worker
        const reasonText = reason ? ` Reason: ${reason}` : '';
        await createNotification(
          `Your withdrawal request of $${withdrawal.amount} has been rejected and coins have been refunded to your account.${reasonText}`,
          withdrawal.workerEmail,
          '/dashboard/withdrawals'
        );

        res.json({ message: 'Withdrawal request rejected successfully' });
      } catch (err) {
        console.error('Reject withdrawal error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // Notification endpoints
    
    // Get notifications for a user
    app.get('/notifications', async (req, res) => {
      try {
        const { email } = req.query;
        
        if (!email) {
          return res.status(400).json({ error: 'Email is required' });
        }

        // Get notifications for the user, sorted by newest first
        const notifications = await notificationsCollection
          .find({ toEmail: email })
          .sort({ time: -1 })
          .limit(50)
          .toArray();

        res.json(notifications);
      } catch (err) {
        console.error('Get notifications error:', err);
        res.status(500).json({ error: 'Failed to fetch notifications' });
      }
    });

    // Mark notification as read
    app.put('/notifications/:id/read', async (req, res) => {
      try {
        const { id } = req.params;
        const { userEmail } = req.body;

        if (!userEmail) {
          return res.status(400).json({ error: 'User email is required' });
        }

        // Update notification as read
        const result = await notificationsCollection.updateOne(
          { 
            _id: new ObjectId(id),
            toEmail: userEmail 
          },
          { $set: { read: true } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({ message: 'Notification marked as read' });
      } catch (err) {
        console.error('Mark notification as read error:', err);
        res.status(500).json({ error: 'Failed to mark notification as read' });
      }
    });

    // Mark all notifications as read
    app.put('/notifications/read-all', async (req, res) => {
      try {
        const { userEmail } = req.body;

        if (!userEmail) {
          return res.status(400).json({ error: 'User email is required' });
        }

        // Update all notifications as read for the user
        await notificationsCollection.updateMany(
          { toEmail: userEmail, read: false },
          { $set: { read: true } }
        );

        res.json({ message: 'All notifications marked as read' });
      } catch (err) {
        console.error('Mark all notifications as read error:', err);
        res.status(500).json({ error: 'Failed to mark all notifications as read' });
      }
    });

    // Delete notification
    app.delete('/notifications/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { userEmail } = req.body;

        if (!userEmail) {
          return res.status(400).json({ error: 'User email is required' });
        }

        // Delete notification
        const result = await notificationsCollection.deleteOne({
          _id: new ObjectId(id),
          toEmail: userEmail
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({ message: 'Notification deleted successfully' });
      } catch (err) {
        console.error('Delete notification error:', err);
        res.status(500).json({ error: 'Failed to delete notification' });
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

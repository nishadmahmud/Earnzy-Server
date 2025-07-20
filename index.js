const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const nodemailer = require('nodemailer');
require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const storage = multer.memoryStorage();
const upload = multer({ storage });

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ph-cluster.8kwdmtt.mongodb.net/?retryWrites=true&w=majority&appName=PH-Cluster`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function run() {
  try {
    console.log("Connected to MongoDB");
    
    const db = client.db("earnzyDB");
    const usersCollection = db.collection("users");
    const tasksCollection = db.collection("tasks");
    const submissionsCollection = db.collection("submissions");
    const notificationsCollection = db.collection("notifications");
    const withdrawalsCollection = db.collection("withdrawals");

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

    app.post('/upload-image', upload.single('image'), async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }

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
        else coins = 10;
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

        if (!title || !detail || !requiredWorkers || !payableAmount || !completionDate || !buyerEmail) {
          return res.status(400).json({ error: 'All fields are required' });
        }

        const buyer = await usersCollection.findOne({ email: buyerEmail });
        if (!buyer) {
          return res.status(404).json({ error: 'Buyer not found' });
        }

        const totalPayable = Number(requiredWorkers) * Number(payableAmount);
        if (buyer.coins < totalPayable) {
          return res.status(400).json({ error: 'Insufficient coins' });
        }

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

        const result = await tasksCollection.insertOne(task);

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

    app.get('/tasks/available', async (req, res) => {
      try {
        const { workerEmail } = req.query;
        
        const availableTasks = await tasksCollection.find({
          status: 'active',
          requiredWorkers: { $gt: 0 }
        }).sort({ createdAt: -1 }).toArray();

        let formattedTasks = availableTasks;
        if (workerEmail) {
          const workerSubmissions = await submissionsCollection.find({
            workerEmail: workerEmail
          }).toArray();
          
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

          formattedTasks = availableTasks.map(task => ({
            ...task,
            completionDate: task.completionDate.toISOString().split('T')[0], // Format as YYYY-MM-DD
            hasSubmitted: submittedTaskIds.has(task._id.toString()),
            isCompleted: completedTaskIds.has(task._id.toString())
          }));
        } else {
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

        let formattedTask = {
          ...task,
          completionDate: task.completionDate.toISOString().split('T')[0]
        };

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

    app.get('/worker/submissions', async (req, res) => {
      try {
        const { workerEmail } = req.query;

        if (!workerEmail) {
          return res.status(400).json({ error: 'Worker email is required' });
        }

        const submissions = await submissionsCollection.find({
          workerEmail: workerEmail
        }).sort({ submittedAt: -1 }).toArray();

        const formattedSubmissions = submissions.map(submission => ({
          ...submission,
          submissionDate: submission.submittedAt.toISOString().split('T')[0],
          submittedAt: submission.submittedAt.toISOString()
        }));

        res.json(formattedSubmissions);
      } catch (err) {
        console.error('Get worker submissions error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    app.post('/worker/withdraw', async (req, res) => {
      try {
        const { workerEmail, workerName, withdrawalCoin, withdrawalAmount, paymentSystem, accountNumber } = req.body;

        if (!workerEmail || !workerName || !withdrawalCoin || !withdrawalAmount || !paymentSystem || !accountNumber) {
          return res.status(400).json({ error: 'All fields are required' });
        }

        const expectedAmount = withdrawalCoin / 20;
        if (Math.abs(withdrawalAmount - expectedAmount) > 0.01) {
          return res.status(400).json({ error: 'Invalid withdrawal amount calculation' });
        }

        const user = await usersCollection.findOne({ email: workerEmail });
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        if (user.coins < withdrawalCoin) {
          return res.status(400).json({ error: 'Insufficient coins' });
        }

        if (withdrawalCoin < 200) {
          return res.status(400).json({ error: 'Minimum withdrawal is 200 coins ($10)' });
        }

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

        await usersCollection.updateOne(
          { email: workerEmail },
          { $inc: { coins: -withdrawalCoin } }
        );

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

    app.get('/worker/withdrawals', async (req, res) => {
      try {
        const { workerEmail } = req.query;

        if (!workerEmail) {
          return res.status(400).json({ error: 'Worker email is required' });
        }

        const withdrawals = await withdrawalsCollection.find({
          workerEmail: workerEmail
        }).sort({ withdrawDate: -1 }).toArray();

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

    app.get('/admin/dashboard', async (req, res) => {
      try {
        const totalWorkers = await usersCollection.countDocuments({ role: 'worker' });
        
        const totalBuyers = await usersCollection.countDocuments({ role: 'buyer' });
        
        const coinAggregation = await usersCollection.aggregate([
          { $group: { _id: null, totalCoins: { $sum: '$coins' } } }
        ]).toArray();
        const totalAvailableCoins = coinAggregation.length > 0 ? coinAggregation[0].totalCoins : 0;
        
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

    app.get('/admin/withdrawals/pending', async (req, res) => {
      try {
        const pendingWithdrawals = await withdrawalsCollection.find({
          status: 'pending'
        }).sort({ withdrawDate: -1 }).toArray();

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

    app.put('/admin/withdrawals/:id/approve', async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid withdrawal ID' });
        }

        const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(id) });
        if (!withdrawal) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        if (withdrawal.status !== 'pending') {
          return res.status(400).json({ error: 'Withdrawal request is not pending' });
        }

        await withdrawalsCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              status: 'approved',
              approvedAt: new Date()
            } 
          }
        );

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

    app.get('/admin/users', async (req, res) => {
      try {
        const users = await usersCollection.find({}).sort({ createdAt: -1 }).toArray();
        
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

        const result = await usersCollection.updateOne(
          { email: email },
          { $set: { role: role } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: 'User not found' });
        }

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

    app.delete('/admin/users/:email', async (req, res) => {
      try {
        const { email } = req.params;

        if (!email) {
          return res.status(400).json({ error: 'Email is required' });
        }

        const user = await usersCollection.findOne({ email: email });
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        await usersCollection.deleteOne({ email: email });

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

    app.get('/admin/tasks', async (req, res) => {
      try {
        const tasks = await tasksCollection.find({}).sort({ createdAt: -1 }).toArray();
        
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

    app.delete('/admin/tasks/:id', async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid task ID' });
        }

        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        await tasksCollection.deleteOne({ _id: new ObjectId(id) });

        await submissionsCollection.deleteMany({ taskId: new ObjectId(id) });

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

    app.get('/top-workers', async (req, res) => {
      try {
        const topWorkers = await usersCollection.find({
          role: 'worker'
        }).sort({ coins: -1 }).limit(6).toArray();

        console.log('Found workers:', topWorkers.length);
        console.log('Workers data:', topWorkers.map(w => ({ name: w.name || w.displayName || w.email, coins: w.coins || 0 })));

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

    app.get('/worker/dashboard', async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const worker = await usersCollection.findOne({ email });
        if (!worker) {
          return res.status(404).json({ error: 'Worker not found' });
        }

        const allSubmissions = await submissionsCollection.find({ workerEmail: email }).toArray();
        
        const pendingSubmissions = allSubmissions.filter(sub => sub.status === 'pending');
        
        const approvedSubmissions = allSubmissions.filter(sub => sub.status === 'approved');
        
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

        const totalEarnings = approvedSubmissionsWithDetails.reduce((sum, sub) => sum + sub.payable_amount, 0);

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

    app.get('/buyer/dashboard', async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const buyer = await usersCollection.findOne({ email });
        if (!buyer) {
          return res.status(404).json({ error: 'Buyer not found' });
        }

        const tasks = await tasksCollection.find({ buyerEmail: email }).toArray();
        
        const totalTasks = tasks.length;
        
        const pendingTasks = tasks.reduce((sum, task) => sum + (task.requiredWorkers || 0), 0);
        
        const totalPayments = tasks.reduce((sum, task) => sum + (task.totalPayable || 0), 0);
        
        const taskIds = tasks.map(task => task._id);
        const pendingSubmissions = await submissionsCollection.find({
          taskId: { $in: taskIds },
          status: 'pending'
        }).toArray();

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
            pendingWorkers: pendingTasks,
            totalPayments
          },
          pendingSubmissions: submissionsWithDetails
        });
      } catch (err) {
        console.error('Buyer dashboard error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    app.put('/submissions/:id/approve', async (req, res) => {
      try {
        const { id } = req.params;
        const { buyerEmail } = req.body;

        if (!buyerEmail) {
          return res.status(400).json({ error: 'Buyer email is required' });
        }

        const submission = await submissionsCollection.findOne({ _id: new ObjectId(id) });
        if (!submission) {
          return res.status(404).json({ error: 'Submission not found' });
        }

        const task = await tasksCollection.findOne({ _id: submission.taskId });
        if (!task || task.buyerEmail !== buyerEmail) {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        await submissionsCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              status: 'approved',
              approvedAt: new Date()
            }
          }
        );

        await usersCollection.updateOne(
          { email: submission.workerEmail },
          { $inc: { coins: task.payableAmount } }
        );

        const buyer = await usersCollection.findOne({ email: buyerEmail });
        const buyerName = buyer?.name || 'Unknown Buyer';

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

    app.put('/submissions/:id/reject', async (req, res) => {
      try {
        const { id } = req.params;
        const { buyerEmail } = req.body;

        if (!buyerEmail) {
          return res.status(400).json({ error: 'Buyer email is required' });
        }

        const submission = await submissionsCollection.findOne({ _id: new ObjectId(id) });
        if (!submission) {
          return res.status(404).json({ error: 'Submission not found' });
        }

        const task = await tasksCollection.findOne({ _id: submission.taskId });
        if (!task || task.buyerEmail !== buyerEmail) {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        await submissionsCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              status: 'rejected',
              rejectedAt: new Date()
            }
          }
        );

        await tasksCollection.updateOne(
          { _id: submission.taskId },
          { $inc: { requiredWorkers: 1 } }
        );

        const buyer = await usersCollection.findOne({ email: buyerEmail });
        const buyerName = buyer?.name || 'Unknown Buyer';

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

    app.post('/submissions', async (req, res) => {
      try {
        const { taskId, workerEmail, submissionDetails } = req.body;

        if (!taskId || !workerEmail || !submissionDetails) {
          return res.status(400).json({ error: 'Task ID, worker email, and submission details are required' });
        }

        const task = await tasksCollection.findOne({ _id: new ObjectId(taskId) });
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        const worker = await usersCollection.findOne({ email: workerEmail });
        if (!worker) {
          return res.status(404).json({ error: 'Worker not found' });
        }

        const existingSubmission = await submissionsCollection.findOne({
          taskId: new ObjectId(taskId),
          workerEmail: workerEmail
        });

        if (existingSubmission) {
          return res.status(400).json({ error: 'You have already submitted for this task' });
        }

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

    app.post('/create-sample-data', async (req, res) => {
      try {
        const task = await tasksCollection.findOne({ status: 'active' });
        if (!task) {
          return res.status(404).json({ error: 'No active tasks found' });
        }

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

        for (const worker of sampleWorkers) {
          const existingWorker = await usersCollection.findOne({ email: worker.email });
          if (!existingWorker) {
            await usersCollection.insertOne(worker);
          }
        }

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

        await submissionsCollection.insertMany(sampleSubmissions);

        res.json({ message: 'Sample data created successfully' });
      } catch (err) {
        console.error('Create sample data error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

    app.get('/tasks', async (req, res) => {
      try {
        const { buyer } = req.query;
        if (!buyer) return res.status(400).json({ error: 'Buyer email is required' });

        const tasks = await tasksCollection.find({ buyerEmail: buyer }).toArray();
        
          const formattedTasks = tasks.map(task => ({
          ...task,
          completionDate: task.completionDate.toISOString().split('T')[0]
        }));

        res.json(formattedTasks);
      } catch (err) {
        console.error('Get tasks error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });

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

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid task ID format' });
        }

        if (!title || !detail || !requiredWorkers || !payableAmount || !completionDate || !submissionInfo || !buyerEmail) {
          return res.status(400).json({ error: 'All fields are required' });
        }

        if (isNaN(requiredWorkers) || isNaN(payableAmount) || Number(requiredWorkers) <= 0 || Number(payableAmount) <= 0) {
          return res.status(400).json({ error: 'Required workers and payable amount must be positive numbers' });
        }

        const parsedDate = new Date(completionDate);
        if (isNaN(parsedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid completion date' });
        }

        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        if (task.buyerEmail !== buyerEmail) {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        const oldTotalPayable = task.totalPayable || 0;
        const newTotalPayable = Number(requiredWorkers) * Number(payableAmount);
        const coinDifference = newTotalPayable - oldTotalPayable;

        console.log('Payment calculation:', { oldTotalPayable, newTotalPayable, coinDifference });

        if (coinDifference > 0) {
          const buyer = await usersCollection.findOne({ email: buyerEmail });
          if (!buyer || buyer.coins < coinDifference) {
            return res.status(400).json({ error: 'Insufficient coins for increased payment' });
          }
        }

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

        if (coinDifference !== 0) {
          const coinUpdateResult = await usersCollection.updateOne(
            { email: buyerEmail },
            { $inc: { coins: -coinDifference } }
          );
          console.log('Coin update result:', coinUpdateResult);
        }

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

    app.delete('/tasks/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { buyerEmail } = req.body;

        if (!buyerEmail) {
          return res.status(400).json({ error: 'Buyer email is required' });
        }

        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }

        if (task.buyerEmail !== buyerEmail) {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        const approvedSubmissions = await submissionsCollection.countDocuments({
          taskId: new ObjectId(id),
          status: 'approved'
        });

        const refundAmount = (task.requiredWorkers - approvedSubmissions) * task.payableAmount;

        await tasksCollection.deleteOne({ _id: new ObjectId(id) });

        await submissionsCollection.deleteMany({ taskId: new ObjectId(id) });

        if (refundAmount > 0) {
          await usersCollection.updateOne(
            { email: buyerEmail },
            { $inc: { coins: refundAmount } }
          );
        }

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

    
    app.post('/create-payment-intent', async (req, res) => {
      try {
        const { amount, coins, userEmail } = req.body;
        
        if (!amount || !coins || !userEmail) {
          return res.status(400).json({ error: 'Missing required fields' });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
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

    app.post('/confirm-payment', async (req, res) => {
      try {
        const { paymentIntentId } = req.body;
        
        if (!paymentIntentId) {
          return res.status(400).json({ error: 'Payment intent ID is required' });
        }

        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        if (paymentIntent.status !== 'succeeded') {
          return res.status(400).json({ error: 'Payment not successful' });
        }

        const { userEmail, coins } = paymentIntent.metadata;
        const coinsToAdd = parseInt(coins);

        const result = await usersCollection.updateOne(
          { email: userEmail },
          { $inc: { coins: coinsToAdd } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: 'User not found' });
        }

        const updatedUser = await usersCollection.findOne({ email: userEmail });

        await createNotification(
          `You have successfully purchased ${coinsToAdd} coins for $${(paymentIntent.amount / 100).toFixed(2)}. Your current balance is ${updatedUser.coins} coins.`,
          userEmail,
          '/dashboard/purchase-coin'
        );

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

    app.get('/payment-history', async (req, res) => {
      try {
        const { email } = req.query;
        
        if (!email) {
          return res.status(400).json({ error: 'Email is required' });
        }

        const paymentIntents = await stripe.paymentIntents.list({
          limit: 50,
        });

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

    
    app.post('/withdrawals', async (req, res) => {
      try {
        const { workerEmail, amount, paymentSystem, accountNumber } = req.body;

        if (!workerEmail || !amount || !paymentSystem || !accountNumber) {
          return res.status(400).json({ error: 'All fields are required' });
        }

        const worker = await usersCollection.findOne({ email: workerEmail });
        if (!worker) {
          return res.status(404).json({ error: 'Worker not found' });
        }

        const COIN_TO_DOLLAR = 20;
        const requiredCoins = amount * COIN_TO_DOLLAR;
        if (worker.coins < requiredCoins) {
          return res.status(400).json({ error: 'Insufficient coins for withdrawal' });
        }

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

    app.put('/withdrawals/:id/approve', async (req, res) => {
      try {
        const { id } = req.params;
        const { adminEmail } = req.body;

        if (!adminEmail) {
          return res.status(400).json({ error: 'Admin email is required' });
        }

        const admin = await usersCollection.findOne({ email: adminEmail });
        if (!admin || admin.role !== 'admin') {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(id) });
        if (!withdrawal) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        if (withdrawal.status !== 'pending') {
          return res.status(400).json({ error: 'Withdrawal request already processed' });
        }

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

    app.put('/withdrawals/:id/reject', async (req, res) => {
      try {
        const { id } = req.params;
        const { adminEmail, reason } = req.body;

        if (!adminEmail) {
          return res.status(400).json({ error: 'Admin email is required' });
        }

        const admin = await usersCollection.findOne({ email: adminEmail });
        if (!admin || admin.role !== 'admin') {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(id) });
        if (!withdrawal) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        if (withdrawal.status !== 'pending') {
          return res.status(400).json({ error: 'Withdrawal request already processed' });
        }

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

        const COIN_TO_DOLLAR = 20;
        const refundCoins = withdrawal.amount * COIN_TO_DOLLAR;
        await usersCollection.updateOne(
          { email: withdrawal.workerEmail },
          { $inc: { coins: refundCoins } }
        );

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

    app.get('/notifications', async (req, res) => {
      try {
        const { email } = req.query;
        
        if (!email) {
          return res.status(400).json({ error: 'Email is required' });
        }

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

    app.put('/notifications/:id/read', async (req, res) => {
      try {
        const { id } = req.params;
        const { userEmail } = req.body;

        if (!userEmail) {
          return res.status(400).json({ error: 'User email is required' });
        }

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

    app.put('/notifications/read-all', async (req, res) => {
      try {
        const { userEmail } = req.body;

        if (!userEmail) {
          return res.status(400).json({ error: 'User email is required' });
        }

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

    app.delete('/notifications/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { userEmail } = req.body;

        if (!userEmail) {
          return res.status(400).json({ error: 'User email is required' });
        }

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

    app.get('/top-workers', async (req, res) => {
      try {
        const topWorkers = await usersCollection
          .find({ role: 'worker' })
          .sort({ coins: -1 })
          .limit(5)
          .toArray();
        
        const specificWorker = {
          _id: 'nishad_mahmud_id',
          name: 'Nishad Mahmud',
          email: 'mahmudnishad253@gmail.com',
          profilePic: 'https://lh3.googleusercontent.com/a/ACg8ocJ4XyM7d1Mh4RpCCBx8XdCNjM4zBz…',
          role: 'worker',
          coins: 170,
          createdAt: new Date()
        };
        
        let allWorkers = [specificWorker, ...topWorkers];
        
        const uniqueWorkers = allWorkers.filter((worker, index, self) => 
          index === self.findIndex(w => w.email === worker.email)
        );
        
        const finalTopWorkers = uniqueWorkers
          .sort((a, b) => b.coins - a.coins)
          .slice(0, 6);
        
        res.json(finalTopWorkers);
      } catch (error) {
        console.error('Error fetching top workers:', error);
        res.status(500).json({ error: 'Failed to fetch top workers' });
      }
    });

    // Get all payments made by a buyer for their tasks
    app.get('/buyer/payments', async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        // Find all tasks created by this buyer
        const tasks = await tasksCollection.find({ buyerEmail: email }).toArray();
        // Each task has totalPayable, title, createdAt
        const payments = tasks.map(task => ({
          taskId: task._id,
          title: task.title,
          amount: task.totalPayable,
          coins: task.totalPayable, // coins spent = totalPayable
          date: task.createdAt || task.created_at || task.created_at,
        }));
        // Sort by date descending
        payments.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(payments);
      } catch (err) {
        console.error('Get buyer payments error:', err);
        res.status(500).json({ error: 'Failed to fetch buyer payments' });
      }
    });


  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

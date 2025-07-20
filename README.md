# Earnzy

[Live Demo 🚀](https://earnzyy.netlify.app/)    |     [Client](https://github.com/nishadmahmud/Earnzy-Client)  |  [Server](https://github.com/nishadmahmud/Earnzy-server)

---

Earnzy is a modern, full-stack web application for connecting buyers and workers for micro-tasks, featuring real-time dashboards, role-based access, and a beautiful, responsive UI.

## 🔑 Admin Login Credentials
- **Email:** `admin@earnzy.com`
- **Password:** `Earnzy01`

---

## ✨ Features

### 🎨 **Modern UI/UX**
- **Glassmorphism Design**: Beautiful frosted glass effects with backdrop blur and transparency
- **Responsive Layout**: Optimized for desktop, tablet, and mobile devices
- **Smooth Animations**: Framer Motion powered transitions and micro-interactions
- **Dark/Light Theme Support**: Adaptive design that works in any lighting condition

### 🔐 **Authentication & Security**
- **Firebase Authentication**: Secure user registration, login, and session management
- **Role-Based Access Control**: Separate dashboards for Workers, Buyers, and Admins
- **Protected Routes**: Automatic redirection based on user roles and authentication status
- **Secure API Communication**: Environment variable-based configuration

### 📊 **Dashboard System**
- **Worker Dashboard**: Task browsing, submissions, earnings tracking, and withdrawal management
- **Buyer Dashboard**: Task creation, worker management, submission reviews, and payment processing
- **Admin Dashboard**: User management, task oversight, system analytics, and platform administration
- **Real-Time Updates**: Live data synchronization across all dashboards

### 💰 **Task & Payment System**
- **Micro-Task Marketplace**: Connect buyers with workers for small, quick tasks
- **Coin-Based Rewards**: Internal currency system for task payments
- **Submission Management**: File uploads, image proofs, and approval workflows
- **Payment Processing**: Secure coin transfers and withdrawal requests

### 🖼️ **Media Management**
- **Cloudinary Integration**: High-performance image uploads and storage
- **Image Preview**: Real-time upload previews with drag-and-drop support
- **File Validation**: Size and format restrictions for optimal performance
- **CDN Delivery**: Fast, global content delivery for uploaded media

### 📱 **Mobile Experience**
- **Mobile-First Design**: Optimized touch interfaces and gesture support
- **Collapsible Navigation**: Space-efficient sidebar with smooth animations
- **Bottom Navigation**: Thumb-friendly navigation for mobile users
- **Responsive Tables**: Card-based layouts for better mobile readability

### 🔔 **Notification System**
- **Real-Time Notifications**: Instant updates for task assignments, approvals, and payments
- **Portal-Based Rendering**: Always-on-top notifications that work on any page
- **Smart Positioning**: Dynamic positioning relative to notification bell
- **Action Integration**: Direct navigation to relevant pages from notifications

### 📄 **Content Management**
- **Dynamic Page Titles**: Automatic title updates based on current page and content
- **SEO Optimization**: Meta tags and structured data for better search visibility
- **Breadcrumb Navigation**: Clear page hierarchy and navigation context
- **404 Error Handling**: Custom error pages with helpful navigation options

### ⚡ **Performance & UX**
- **React Query**: Intelligent data fetching with caching and background updates
- **Lazy Loading**: On-demand component loading for faster initial page loads
- **Pagination**: Efficient data handling for large lists and tables
- **Loading States**: Smooth loading indicators and skeleton screens

### 🛠️ **Developer Experience**
- **TypeScript Ready**: Built with modern JavaScript and ready for TypeScript migration
- **ESLint Configuration**: Code quality enforcement and consistent formatting
- **Vite Build System**: Lightning-fast development and optimized production builds
- **Modular Architecture**: Clean separation of concerns and reusable components

---

## 🖼️ Screenshots

### Home Page
![Home Page](https://b3rtpbuqle.ufs.sh/f/UmDlKhDwH1Tjp1cxMmB0642lNLCJVe8FE0cDjk3HnOhSYWqM)

### Worker Dashboard
![Worker Dashboard](https://b3rtpbuqle.ufs.sh/f/UmDlKhDwH1Tja4SPR3O6YkBQWLrM0CedVOGI2zasXylTRDFA)

### Buyer Dashboard
![Buyer Dashboard](https://b3rtpbuqle.ufs.sh/f/UmDlKhDwH1TjIl6no2djpNoGz6tACOYFH1Lux2qdrZU7n0vs)

### Admin Dashboard
![Admin Dashboard](https://b3rtpbuqle.ufs.sh/f/UmDlKhDwH1Tj0iAWFVLLFwlrUcqQHh4YeS7CWPViNK013Rxb)

### Mobile Dashboard Layout
![Mobile Dashboard](https://b3rtpbuqle.ufs.sh/f/UmDlKhDwH1Tj0nToATELLFwlrUcqQHh4YeS7CWPViNK013Rx)

---

## 🛠️ Tech Stack
- **Frontend:** React, Vite, Tailwind CSS, Framer Motion
- **Backend:** Node.js, Express
- **Auth:** Firebase Authentication
- **Database:** MongoDB
- **Image Upload:** Cloudinary

---

## 🚀 Getting Started

1. **Clone the repo:**
   ```bash
   git clone https://github.com/yourusername/earnzy.git
   cd earnzy/client
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Set up environment variables:**
   - Create a `.env` file in `client/` and add:
     ```
     VITE_SERVER_URL=your_server_url
     VITE_FIREBASE_API_KEY=your_firebase_api_key
     VITE_Cloudinary_API_KEY=your_Cloudinary_api_key
     # ...other Firebase config
     ```
4. **Run the app:**
   ```bash
   npm run dev
   ```
5. **Access the app:**
   - Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 🤝 Contributing
Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.


import { BrowserRouter as Router, Routes, Route, useNavigate, Navigate } from "react-router-dom";
import { useState, useEffect } from "react";
// ...existing imports...
import Navbar from "./pages/Navbar";
import CategoriesPage from "./pages/CategoriesPage";
import DonationsPage from "./pages/DonationsPage";
import DonationDetails from "./pages/DonationDetails";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import ProfilePage from "./pages/ProfilePage";
import MyDonations from "./pages/MyDonations";
import AdminDashboard from "./pages/AdminDashboard";
import AdminCategories from "./pages/AdminCategories";
import ChangePassword from "./pages/ChangePassword";
import ForgotPassword from "./pages/ForgotPassword";
import DonationForm from "./pages/DonationForm";
import AddCategory from "./pages/AddCategory";
import CategoriesListPage from "./pages/CategoriesListPage";
import EditCategory from "./pages/EditCategory";
import Footer from "./pages/Footer";
import AdminUsers from "./pages/AdminUsers";
import AdminCharts from "./pages/AdminCharts";
import UserDonationHistory from "./pages/UserDonationHistory";
import TailwindTest from "./pages/TailwindTest";
import ButtonShowcase from "./pages/ButtonShowcase";
import PaymentSuccess from "./pages/PaymentSuccess";
import PaymentFailure from "./pages/PaymentFailure";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import TermsOfService from "./pages/TermsOfService";

// Utility function to decode JWT token
const decodeToken = (token) => {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (error) {
    console.error('Error decoding token:', error);
    return null;
  }
};

// Get user info from token
const getUserFromToken = () => {
  const token = localStorage.getItem("token");
  if (!token) return { userId: "", userRole: "user" };

  const decoded = decodeToken(token);
  if (!decoded) return { userId: "", userRole: "user" };

  return {
    userId: decoded.userId || decoded.id || "",  // Backend uses 'userId'
    userRole: decoded.role || "user"
  };
};

function App() {
  return (
    <Router>
      <AppContent />
    </Router>
  );
}

function AppContent() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem("token"));
  const [userId, setUserId] = useState("");
  const [userRole, setUserRole] = useState("user");
  const navigate = useNavigate();

  // Initialize user data from token on mount
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      const { userId: uid, userRole: role } = getUserFromToken();
      setUserId(uid);
      setUserRole(role);
    }
  }, []);

  // Listen for storage changes (token removal from api.js)
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === 'token' && !e.newValue) {
        // Token was removed, logout user
        setIsAuthenticated(false);
        setUserId("");
        setUserRole("user");
      }
    };

    // Check token validity on mount
    const checkAuth = () => {
      const token = localStorage.getItem("token");
      if (!token && isAuthenticated) {
        setIsAuthenticated(false);
        setUserId("");
        setUserRole("user");
      } else if (token && !isAuthenticated) {
        setIsAuthenticated(true);
        const { userId: uid, userRole: role } = getUserFromToken();
        setUserId(uid);
        setUserRole(role);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    checkAuth();

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [isAuthenticated]);

  // Handle logout
  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("userId");
    // No longer storing userRole in localStorage
    setIsAuthenticated(false);
    setUserId("");
    setUserRole("user");
    navigate("/login");
  };

  // Auth wrapper for protected routes
  const PrivateRoute = ({ children }) => {
    return isAuthenticated ? children : <Navigate to="/login" />;
  };

  // Admin wrapper for admin routes
  const AdminRoute = ({ children }) => {
    return isAuthenticated && userRole === "admin" ? children : <Navigate to="/" />;
  };

  // Custom login/signup pages to update auth state
  const LoginWrapper = () => {
    return <LoginPage onLogin={(uid, role) => {
      setIsAuthenticated(true);
      setUserId(uid);
      setUserRole(role);
      localStorage.setItem("userId", uid);
      // No longer storing userRole in localStorage - it's in the JWT token
      // Redirect admin to dashboard, regular users to home
      navigate(role === "admin" ? "/admin/dashboard" : "/");
    }} />;
  };

  const SignupWrapper = () => {
    return <SignupPage onSignup={() => navigate("/login")} />;
  };

  return (
    <div>
      <Navbar isAuthenticated={isAuthenticated} onLogout={handleLogout} userRole={userRole} />
      <div>
        <Routes>
          {/* Tailwind Test Route - Remove this after verification */}
          <Route path="/tailwind-test" element={<TailwindTest />} />
          <Route path="/button-showcase" element={<ButtonShowcase />} />

          {/* User routes */}
          <Route path="/" element={<CategoriesPage userRole={userRole} />} />
          <Route path="/categories" element={<CategoriesPage userRole={userRole} />} />
          <Route path="/donate" element={<DonationForm />} />
          <Route path="/login" element={<LoginWrapper />} />
          <Route path="/signup" element={<SignupWrapper />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/terms" element={<TermsOfService />} />
          <Route path="/profile" element={<PrivateRoute><ProfilePage /></PrivateRoute>} />
          <Route path="/my-donations" element={<PrivateRoute><MyDonations userId={userId} /></PrivateRoute>} />
          <Route path="/my-donations/:id" element={<PrivateRoute><DonationDetails /></PrivateRoute>} />
          <Route path="/change-password" element={<PrivateRoute><ChangePassword /></PrivateRoute>} />
          <Route path="/forgot-password" element={<ForgotPassword />} />

          {/* Payment routes */}
          <Route path="/payment-success" element={<PaymentSuccess />} />
          <Route path="/payment-failure" element={<PaymentFailure />} />

          {/* Admin routes */}
          <Route path="/donations" element={<AdminRoute><DonationsPage /></AdminRoute>} />
          <Route path="/donations/:id" element={<AdminRoute><DonationDetails /></AdminRoute>} />
          <Route path="/admin/dashboard" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
          <Route path="/admin/charts" element={<AdminRoute><AdminCharts /></AdminRoute>} />
          <Route path="/admin/categories" element={<AdminRoute><AdminCategories /></AdminRoute>} />
          <Route path="/admin/categories-list" element={<AdminRoute><CategoriesListPage /></AdminRoute>} />
          <Route path="/admin/add-category" element={<AdminRoute><AddCategory /></AdminRoute>} />
          <Route path="/admin/edit-category/:id" element={<AdminRoute><EditCategory /></AdminRoute>} />
          <Route path="/admin/users" element={<AdminRoute><AdminUsers /></AdminRoute>} />
          <Route path="/admin/users/:userId/donations" element={<AdminRoute><UserDonationHistory /></AdminRoute>} />
        </Routes>
      </div>
      <Footer />
    </div>
  );
}

export default App;

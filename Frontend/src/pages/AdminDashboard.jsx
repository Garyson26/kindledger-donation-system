import React, { useEffect, useState } from "react";
import { adminAPI } from "../utils/api";

function StatCard({ icon, title, value, subtitle, color, loading }) {
  const colorMap = {
    blue: "bg-[#05699e] text-white",
    green: "bg-green-600 text-white",
    purple: "bg-purple-600 text-white",
    orange: "bg-orange-600 text-white",
    yellow: "bg-yellow-600 text-white",
    red: "bg-red-600 text-white",
  };

  return (
    <div className={`${colorMap[color]} rounded-lg shadow-sm p-6 transition-shadow duration-200 hover:shadow-md`}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-4xl">{icon}</div>
        {loading ? (
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
        ) : (
          <div className="text-right">
            <div className="text-3xl font-bold">
              {value.toLocaleString()}
            </div>
            {subtitle && (
              <div className="text-sm opacity-90 mt-1">{subtitle}</div>
            )}
          </div>
        )}
      </div>
      <div className="text-base font-semibold">{title}</div>
    </div>
  );
}

function QuickActionCard({ icon, title, description, link }) {
  return (
    <a
      href={link}
      className="bg-white border border-gray-200 hover:border-blue-300 rounded-lg p-6 transition-all duration-200 hover:shadow-md block group"
    >
      <div className="flex items-start gap-4">
        <div className="text-3xl flex-shrink-0">
          {icon}
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">{title}</h3>
          <p className="text-sm text-gray-600">{description}</p>
        </div>
        <div className="flex-shrink-0 text-xl text-[#05699e]">
          →
        </div>
      </div>
    </a>
  );
}

function AdminDashboard() {
  const [stats, setStats] = useState({ users: 0, donations: 0, categories: 0, approved: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const { data, error, ok } = await adminAPI.getStats();

        if (!ok) {
          throw new Error(error || "Failed to fetch dashboard statistics");
        }

        setStats(data);
      } catch (err) {
        console.error("Dashboard stats error:", err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  if (error) {
    return (
      <div className="box-mrg bg-gray-50 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="bg-white rounded-lg shadow-sm p-8 text-center border border-red-200">
            <div className="text-6xl mb-4">⚠️</div>
            <h3 className="text-2xl font-bold text-gray-900 mb-2">Unable to load dashboard</h3>
            <p className="text-gray-600 mb-6">{error}</p>
            <button
              className="px-4 py-2 bg-[#05699e] hover:bg-[#044d73] text-white font-medium rounded-lg transition-colors duration-200"
              onClick={() => window.location.reload()}
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="box-mrg bg-gray-50 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">
                Admin Dashboard
              </h1>
              <p className="text-gray-600 text-base">
                Monitor and manage your donation platform
              </p>
            </div>
            <div className="flex items-center gap-3 bg-white px-4 py-2 rounded-lg shadow-sm border border-gray-200">
              <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-sm font-medium text-gray-700">
                {new Date().toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                })}
              </span>
            </div>
          </div>
        </div>

        {/* Statistics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          <StatCard
            icon="👥"
            title="Total Users"
            value={stats.users}
            subtitle="registered"
            color="blue"
            loading={loading}
          />

          <StatCard
            icon="💰"
            title="Total Donations"
            value={stats.donations}
            subtitle="received"
            color="green"
            loading={loading}
          />

          <StatCard
            icon="📂"
            title="Categories"
            value={stats.categories}
            subtitle="active"
            color="purple"
            loading={loading}
          />
        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-lg shadow-sm p-6 mb-8 border border-gray-200">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-1">Quick Actions</h2>
            <p className="text-sm text-gray-600">Common administrative tasks</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <QuickActionCard
              icon="📝"
              title="Manage Categories"
              description="Add, edit, or remove donation categories"
              link="/admin/categories-list"
            />

            <QuickActionCard
              icon="👥"
              title="View Users"
              description="Monitor user accounts and activity"
              link="/admin/users"
            />

            <QuickActionCard
              icon="📊"
              title="All Donations"
              description="View and manage all donation records"
              link="/donations"
            />

            <QuickActionCard
              icon="➕"
              title="Add Category"
              description="Create new donation categories"
              link="/admin/add-category"
            />

            <QuickActionCard
              icon="📈"
              title="View Charts"
              description="View donation statistics and charts"
              link="/admin/charts"
            />
          </div>
        </div>

      </div>
    </div>
  );
}

export default AdminDashboard;


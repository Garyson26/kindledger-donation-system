import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import Button from "../components/Button";

function Navbar({ isAuthenticated, onLogout, userRole }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const location = useLocation();

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  const closeMenu = () => {
    setIsMenuOpen(false);
    setIsDropdownOpen(false);
  };

  const toggleDropdown = () => {
    setIsDropdownOpen(!isDropdownOpen);
  };

  const isActive = (path) => {
    return location.pathname === path;
  };

  return (
    <nav className="bg-white shadow-lg sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <div className="flex-shrink-0">
            <Link to="/" onClick={closeMenu} className="flex items-center">
              <img
                src="/images/logo.jpg"
                alt="For Ocean Foundation Logo"
                className="h-10 w-auto rounded-md hover:opacity-90 transition-opacity"
              />
            </Link>
          </div>

          {/* Desktop Navigation */}
          <div className="hidden lg:flex lg:items-center lg:space-x-1">
            {/*{!isAuthenticated && userRole !== "admin" && (*/}
            {/*    <>*/}
            {/*  /!* Categories Link *!/*/}
            {/*  <Link*/}
            {/*    to="/categories"*/}
            {/*    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${*/}
            {/*      isActive('/categories')*/}
            {/*        ? 'bg-blue-600 text-white'*/}
            {/*        : 'text-gray-700 hover:bg-gray-100 hover:text-blue-600'*/}
            {/*    }`}*/}
            {/*  >*/}
            {/*    Categories*/}
            {/*  </Link>*/}
            {/*  </>*/}
            {/*)}*/}
            {/* Admin Link */}
            {isAuthenticated && userRole === "admin" && (
              <>
              <Link
                  to="/admin/dashboard"
                  onClick={() => setIsDropdownOpen(false)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
                      isActive('/admin/dashboard')
                          ? 'bg-[#05699e] text-white'
                          : 'text-gray-700 hover:bg-gray-100 hover:text-[#05699e]'
                  }`}
              >
                Dashboard
              </Link>
              <Link
                to="/donations"
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
                  isActive('/donations')
                    ? 'bg-[#05699e] text-white'
                    : 'text-gray-700 hover:bg-gray-100 hover:text-[#05699e]'
                }`}
              >
                Donations
              </Link>



              <Link
                  to="/admin/charts"
                  onClick={() => setIsDropdownOpen(false)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
                      isActive('/admin/charts')
                          ? 'bg-[#05699e] text-white'
                          : 'text-gray-700 hover:bg-gray-100 hover:text-[#05699e]'
                  }`}
              >
                Charts
              </Link>
              <Link
                  to="/admin/users"
                  onClick={() => setIsDropdownOpen(false)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
                      isActive('/admin/users')
                          ? 'bg-[#05699e] text-white'
                          : 'text-gray-700 hover:bg-gray-100 hover:text-[#05699e]'
                  }`}
              >
                Users
              </Link>
              {/* SPEC-5 5.2. A settings page nothing links to is a page nobody
                  finds, and this one is how an NGO makes the installation
                  theirs - the reason the whitelabel phase exists. */}
              <Link
                  to="/admin/branding"
                  onClick={() => setIsDropdownOpen(false)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
                      isActive('/admin/branding')
                          ? 'bg-[#05699e] text-white'
                          : 'text-gray-700 hover:bg-gray-100 hover:text-[#05699e]'
                  }`}
              >
                Branding
              </Link>
                </>
            )}

            {/* User My Donations Link */}
            {isAuthenticated && userRole !== "admin" && (
                <>
              <Link
                to="/my-donations"
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
                  isActive('/my-donations')
                    ? 'bg-[#05699e] text-white'
                    : 'text-gray-700 hover:bg-gray-100 hover:text-[#05699e]'
                }`}
              >
                My Donations
              </Link>
              <Link
              to="/donate"
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
              isActive('/donate')
              ? 'bg-[#05699e] text-white'
              : 'text-gray-700 hover:bg-gray-100 hover:text-[#05699e]'
            }`}
          >
            Donate
          </Link>
                </>
            )}

               {isAuthenticated && (
                <>
              <Link
                  to="/categories"
                  onClick={() => setIsDropdownOpen(false)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
                      isActive('/categories')
                          ? 'bg-[#05699e] text-white'
                          : 'text-gray-700 hover:bg-gray-100 hover:text-[#05699e]'
                  }`}
              >
                Categories
              </Link>
            </>
            )}
          {/* Auth Actions */}
          <div className="flex items-center space-x-2 ml-4">
            {!isAuthenticated && (
              <>
                <Link to="/login">
                  <Button variant="ghost" size="sm">
                    Login
                  </Button>
                </Link>
                <Link to="/signup">
                  <Button variant="primary" size="sm">
                    Sign Up
                  </Button>
                </Link>
              </>
            )}
            {isAuthenticated && (
              <div className="relative">
                <button
                  onClick={toggleDropdown}
                  className="flex items-center justify-center w-10 h-10 rounded-full bg-[#05699e] text-white hover:bg-[#044d73] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#05699e] transition-colors duration-200"
                  aria-label="User menu"
                >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </button>

                  {/* User Dropdown Menu */}
                  {isDropdownOpen && (
                    <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg py-1 z-50 border border-gray-200">
                <Link
                  to="/profile"
                  onClick={() => setIsDropdownOpen(false)}
                  className={`flex items-center px-4 py-2 text-sm transition-colors duration-200 ${
                    isActive('/profile')
                      ? 'bg-[#05699e]/10 text-[#05699e]'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  Profile
                </Link>
                <Link
                  to="/change-password"
                  onClick={() => setIsDropdownOpen(false)}
                  className={`flex items-center px-4 py-2 text-sm transition-colors duration-200 ${
                    isActive('/change-password')
                      ? 'bg-[#05699e]/10 text-[#05699e]'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                        <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                        </svg>
                        Change Password
                      </Link>
                      <div className="border-t border-gray-200 my-1"></div>
                      <button
                        onClick={() => {
                          setIsDropdownOpen(false);
                          onLogout();
                        }}
                        className="flex items-center w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors duration-200"
                      >
                        <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                        </svg>
                        Logout
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Mobile Menu Button */}
          <div className="lg:hidden">
            <button
              onClick={toggleMenu}
              className="inline-flex items-center justify-center p-2 rounded-md text-gray-700 hover:text-blue-600 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 transition-colors duration-200"
              aria-label="Toggle menu"
            >
              <svg
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {isMenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      <div className={`lg:hidden transition-all duration-300 ease-in-out ${
        isMenuOpen ? 'max-h-screen opacity-100' : 'max-h-0 opacity-0 overflow-hidden'
      }`}>
        <div className="px-2 pt-2 pb-3 space-y-1 bg-gray-50 shadow-inner">
          {/* Categories */}
          <Link
            to="/categories"
            onClick={closeMenu}
            className={`block px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
              isActive('/categories')
                ? 'bg-[#05699e] text-white'
                : 'text-gray-700 hover:bg-gray-200 hover:text-[#05699e]'
            }`}
          >
            Categories
          </Link>

          {/* Admin Donations */}
          {isAuthenticated && userRole === "admin" && (
            <Link
              to="/donations"
              onClick={closeMenu}
              className={`block px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
                isActive('/donations')
                  ? 'bg-[#05699e] text-white'
                  : 'text-gray-700 hover:bg-gray-200 hover:text-[#05699e]'
              }`}
            >
              Donations
            </Link>
          )}

          {/* User My Donations */}
          {isAuthenticated && userRole !== "admin" && (
            <Link
              to="/my-donations"
              onClick={closeMenu}
              className={`block px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
                isActive('/my-donations')
                  ? 'bg-[#05699e] text-white'
                  : 'text-gray-700 hover:bg-gray-200 hover:text-[#05699e]'
              }`}
            >
              My DonationsMy Donations
            </Link>
          )}

          {/* Admin Links */}
          {isAuthenticated && userRole === "admin" && (
            <>
              <div className="border-t border-gray-300 my-2"></div>
              <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Admin Panel
              </div>
              <Link
                to="/admin/dashboard"
                onClick={closeMenu}
                className={`block px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
                  isActive('/admin/dashboard')
                    ? 'bg-[#05699e] text-white'
                    : 'text-gray-700 hover:bg-gray-200 hover:text-[#05699e]'
                }`}
              >
                Dashboard
              </Link>
              <Link
                to="/admin/charts"
                onClick={closeMenu}
                className={`block px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
                  isActive('/admin/charts')
                    ? 'bg-[#05699e] text-white'
                    : 'text-gray-700 hover:bg-gray-200 hover:text-[#05699e]'
                }`}
              >
                Charts
              </Link>
              <Link
                to="/admin/users"
                onClick={closeMenu}
                className={`block px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
                  isActive('/admin/users')
                    ? 'bg-[#05699e] text-white'
                    : 'text-gray-700 hover:bg-gray-200 hover:text-[#05699e]'
                }`}
              >
                Users
              </Link>
              <Link
                to="/admin/categories-list"
                onClick={closeMenu}
                className={`block px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
                  isActive('/admin/categories-list') || isActive('/admin/add-category')
                    ? 'bg-[#05699e] text-white'
                    : 'text-gray-700 hover:bg-gray-200 hover:text-[#05699e]'
                }`}
              >
                Categories
              </Link>
            </>
          )}

          {/* User Donate */}
          {isAuthenticated && userRole !== "admin" && (
            <Link
            to="/donate"
            onClick={closeMenu}
            className={`block px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
              isActive('/donate')
                ? 'bg-[#05699e] text-white'
                : 'bg-[#05699e] text-white hover:bg-[#044d73]'
            }`}
          >
            Donate
          </Link>
          )}

          {/* Mobile Auth Actions */}
          <div className="border-t border-gray-300 my-2"></div>
          {!isAuthenticated && (
            <>
              <Link
                to="/login"
                onClick={closeMenu}
                className="block px-3 py-2 rounded-md text-base font-medium text-gray-700 hover:bg-gray-200 hover:text-blue-600 transition-colors duration-200"
              >
                Login
              </Link>
              <Link
                to="/signup"
                onClick={closeMenu}
                className="block px-3 py-2 rounded-md text-base font-medium text-gray-700 hover:bg-gray-200 hover:text-blue-600 transition-colors duration-200"
              >
                Sign Up
              </Link>
            </>
          )}
          {isAuthenticated && (
            <>
              <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Account
              </div>
              <Link
            to="/profile"
            onClick={closeMenu}
            className={`flex items-center px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
              isActive('/profile')
                ? 'bg-[#05699e] text-white'
                : 'text-gray-700 hover:bg-gray-200 hover:text-[#05699e]'
            }`}
          >
            <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            Profile
          </Link>
          <Link
            to="/change-password"
            onClick={closeMenu}
            className={`flex items-center px-3 py-2 rounded-md text-base font-medium transition-colors duration-200 ${
              isActive('/change-password')
                ? 'bg-[#05699e] text-white'
                : 'text-gray-700 hover:bg-gray-200 hover:text-[#05699e]'
            }`}
          >
                <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                Change Password
              </Link>
              <button
                onClick={() => {
                  onLogout();
                  closeMenu();
                }}
                className="flex items-center w-full text-left px-3 py-2 rounded-md text-base font-medium text-red-600 hover:bg-red-50 hover:text-red-700 transition-colors duration-200"
              >
                <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Logout
              </button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

export default Navbar;

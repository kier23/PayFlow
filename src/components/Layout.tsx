import React from "react";
import { Link, useLocation } from "react-router-dom";

interface LayoutProps {
  children: React.ReactNode;
  showNavigation?: boolean;
}

const Layout: React.FC<LayoutProps> = ({ children, showNavigation = true }) => {
  const location = useLocation();

  // Define navigation items
  const navItems = [
    { path: "/", label: "Login" },
    { path: "/complete-profile", label: "Complete Profile" },
    { path: "/admin-dashboard", label: "Dashboard" },
    { path: "/superadmin", label: "Superadmin" },
  ];

  return (
    <div className="min-h-screen bg-linear-to-br from-background via-orange-50/10 to-background">
      {/* Header */}
      <header className="bg-white/95 backdrop-blur-xl shadow-xl border-b-2 border-primary sticky top-0 z-40">
        <div className="container mx-auto px-4 py-5 flex justify-between items-center">
          <Link
            to="/"
            className="text-2xl font-extrabold bg-linear-to-r from-primary via-orange-600 to-black bg-clip-text text-transparent flex items-center gap-3"
          >
            <div className="w-10 h-10 rounded-xl bg-linear-to-br from-primary to-orange-700 flex items-center justify-center shadow-lg">
              <img
                src="/PayFlow-Logo_white.png"
                alt="PayFlow Logo"
                className="w-full h-full object-cover"
              />
            </div>
            PayFlow - PalawanSU
          </Link>

          {showNavigation && (
            <nav>
              <ul className="flex space-x-2">
                {navItems.map((item) => (
                  <li key={item.path}>
                    <Link
                      to={item.path}
                      className={`px-4 py-2 rounded-xl font-semibold transition-all duration-200 ${
                        location.pathname === item.path
                          ? "bg-linear-to-r from-primary to-orange-600 text-white shadow-lg transform scale-105"
                          : "text-gray-700 hover:bg-primary/10 hover:text-primary"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className={showNavigation ? "container mx-auto px-4 py-8" : ""}>
        {children}
      </main>

      {/* Footer */}
      <footer className="bg-white/95 backdrop-blur-xl border-t-2 border-primary py-8 shadow-lg">
        <div className="container mx-auto px-4 text-center">
          <p className="text-gray-700 font-medium">
            © {new Date().getFullYear()} PayFlow - Queue Management System
          </p>
          <p className="text-gray-500 text-sm mt-2 font-medium">
            Palawan State University
          </p>
        </div>
      </footer>
    </div>
  );
};

export default Layout;

import React, { useEffect } from "react";
import { supabase } from "../lib/supabase";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLock } from "@fortawesome/free-solid-svg-icons";
import PSU from "../assets/PSU-new.jpg";

const LoginPage: React.FC = () => {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;

    const checkSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!mounted || !session?.user?.id) return;

      const { data: profile } = await supabase
        .from("Profiles")
        .select("role")
        .eq("id", session.user.id)
        .single();

      if (profile?.role === "superadmin") {
        navigate("/superadmin", { replace: true });
      } else {
        navigate("/admin-dashboard", { replace: true });
      }
    };

    checkSession();

    return () => {
      mounted = false;
    };
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: username,
      password: password,
    });

    console.log("Login response:", data, error);
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    const userId = data?.user?.id;
    if (!userId) {
      setError("Unable to determine user after login");
      setLoading(false);
      return;
    }

    const { data: profile, error: profileError } = await supabase
      .from("Profiles")
      .select("role")
      .eq("id", userId)
      .single();

    if (profileError || !profile) {
      setError(profileError?.message || "Profile not found");
      setLoading(false);
      return;
    }

    if (profile.role === "superadmin") {
      navigate("/superadmin");
    } else if (profile.role === "admin") {
      navigate("/admin-dashboard");
    } else {
      setError("Access restricted: unauthorized role");
      await supabase.auth.signOut();
      setLoading(false);
      return;
    }

    setLoading(false);
    setUsername("");
    setPassword("");
  };
  return (
    <Layout showNavigation={false}>
      <div className="relative flex items-center justify-center min-h-[80vh] overflow-hidden">
        {/* Background Image */}
        <div
          className="absolute inset-0 bg-cover bg-center z-0"
          style={{
            backgroundImage: `url(${PSU})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          }}
        ></div>

        {/* White Filter Overlay */}
        <div className="absolute inset-0 bg-white/70"></div>
        <div className="z-10 w-full max-w-md p-10 space-y-8 bg-white rounded-3xl shadow-2xl border border-primary/20">
          <div className="text-center">
            <div className="mx-auto h-20 w-20 rounded-2xl bg-linear-to-br from-primary to-orange-700 flex items-center justify-center shadow-xl transform hover:rotate-6 transition-transform">
              <FontAwesomeIcon icon={faLock} className="text-3xl text-white" />
            </div>
            <h2 className="mt-6 text-3xl font-extrabold bg-linear-to-r from-primary via-orange-600 to-black bg-clip-text text-transparent">
              Welcome Back
            </h2>
            <p className="mt-3 text-gray-600 font-medium">
              Sign in to your account
            </p>
          </div>

          {error && (
            <div className="rounded-2xl bg-red-50 p-4 border border-red-200 shadow-md">
              <div className="flex">
                <div className="shrink-0">
                  <svg
                    className="h-5 w-5 text-red-400"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div className="ml-3">
                  <h3 className="text-sm font-semibold text-red-800">
                    {error}
                  </h3>
                </div>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-semibold text-gray-700 mb-2"
              >
                Email Address
              </label>
              <input
                type="email"
                id="email"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3.5 border-2 border-gray-300 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary transition-all font-medium"
                placeholder="Enter your email address"
                required
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-semibold text-gray-700 mb-2"
              >
                Password
              </label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3.5 border-2 border-gray-300 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary transition-all font-medium"
                placeholder="Enter your password"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-4 text-base font-bold text-white bg-linear-to-r from-primary via-orange-600 to-primary rounded-xl hover:from-orange-700 hover:via-orange-700 hover:to-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition-all transform hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
            >
              {loading ? (
                <span className="flex items-center justify-center">
                  <svg
                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  Signing in...
                </span>
              ) : (
                "Sign In"
              )}
            </button>
          </form>
        </div>
      </div>
    </Layout>
  );
};

export default LoginPage;

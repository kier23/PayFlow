import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faClipboardList,
  faChartLine,
  faCalendarAlt,
  faHourglassHalf,
  faCheck,
  faForward,
  faTimesCircle,
} from "@fortawesome/free-solid-svg-icons";
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

type Profile = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type QueueItem = {
  id: string;
  name: string;
  status: string;
  date: string;
  managed_by: string;
  qr: string;
  latest_number: number;
  is_active: boolean;
};

type TicketAnalytics = {
  waiting: number;
  serving: number;
  done: number;
  skipped: number;
  cancelled: number;
};

type TimeFilter = "weekly" | "monthly" | "yearly";

const AdminDashboard = () => {
  const [admin, setAdmin] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [creatingQueue, setCreatingQueue] = useState(false);
  const [queueName, setQueueName] = useState("");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("weekly");
  const [ticketAnalytics, setTicketAnalytics] = useState<TicketAnalytics>({
    waiting: 0,
    serving: 0,
    done: 0,
    skipped: 0,
    cancelled: 0,
  });
  const [queueGrowthData, setQueueGrowthData] = useState<any[]>([]);
  const [inactiveQueues, setInactiveQueues] = useState<QueueItem[]>([]);
  const [showInactiveDialog, setShowInactiveDialog] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchProfiles = async () => {
      setLoading(true);
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError) {
        setError(userError.message);
        setLoading(false);
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("Profiles")
        .select("*")
        .eq("id", user?.id)
        .single();
      if (profileError) {
        setError(profileError.message);
        setLoading(false);
        return;
      }
      if (profile.role !== "admin") {
        setError("Unauthorized access");
        setLoading(false);
        return;
      }
      setAdmin(profile);

      // Fetch queues managed by the current user
      // Use profile.id instead of user?.id for consistency
      const { data: queueData, error: queueError } = await supabase
        .from("Queue")
        .select("*")
        .eq("managed_by", profile.id)
        .eq("is_active", true);

      if (queueError) {
        setError(queueError.message || "Error fetching queues");
        setLoading(false);
        return;
      } else {
        setQueue(queueData || []);
      }

      setLoading(false);
    };
    fetchProfiles();
  }, []);

  const fetchInactiveQueues = async () => {
    if (!admin) return;

    const { data, error } = await supabase
      .from("Queue")
      .select("*")
      .eq("managed_by", admin.id)
      .eq("is_active", false);

    if (error) {
      setError(error.message);
      return;
    }

    setInactiveQueues(data || []);
  };

  // Fetch ticket analytics based on time filter
  useEffect(() => {
    const fetchAnalytics = async () => {
      if (!admin || queue.length === 0) return;

      const queueIds = queue.map((q) => q.id);

      // Calculate date range based on filter
      const now = new Date();
      let startDate = new Date();

      if (timeFilter === "weekly") {
        startDate.setDate(now.getDate() - 7);
      } else if (timeFilter === "monthly") {
        startDate.setMonth(now.getMonth() - 1);
      } else if (timeFilter === "yearly") {
        startDate.setFullYear(now.getFullYear() - 1);
      }

      // Fetch tickets for admin's queues
      const { data: tickets } = await supabase
        .from("Queue_Tickets")
        .select("status, created_at")
        .in("queue_id", queueIds)
        .gte("created_at", startDate.toISOString());

      if (tickets) {
        const analytics: TicketAnalytics = {
          waiting: 0,
          serving: 0,
          done: 0,
          skipped: 0,
          cancelled: 0,
        };

        tickets.forEach((ticket) => {
          if (ticket.status in analytics) {
            analytics[ticket.status as keyof TicketAnalytics]++;
          }
        });

        setTicketAnalytics(analytics);
      }

      // Fetch queue growth data - count actual tickets per day
      const { data: queueStats } = await supabase
        .from("Queue_Tickets")
        .select("created_at")
        .in("queue_id", queueIds)
        .gte("created_at", startDate.toISOString())
        .order("created_at", { ascending: true });

      if (queueStats) {
        // Group tickets by date and count them
        const ticketsByDate = new Map<string, number>();

        queueStats.forEach((ticket) => {
          const date = new Date(ticket.created_at).toLocaleDateString();
          ticketsByDate.set(date, (ticketsByDate.get(date) || 0) + 1);
        });

        // Convert to chart data format
        const growthData = Array.from(ticketsByDate.entries())
          .map(([date, count]) => ({
            name: date,
            tickets: count,
          }))
          .sort((a, b) => {
            // Sort by date
            const dateA = new Date(a.name).getTime();
            const dateB = new Date(b.name).getTime();
            return dateA - dateB;
          });

        setQueueGrowthData(growthData);
      }
    };

    fetchAnalytics();
  }, [admin, queue, timeFilter]);

  const handleCreateQueue = async () => {
    if (!admin) {
      setError("Admin profile not loaded");
      return;
    }

    if (!queueName.trim()) {
      setError("Please enter a queue name");
      return;
    }

    setCreatingQueue(true);
    setError(null);
    setShowConfirmDialog(false);

    try {
      // Use Supabase functions.invoke with the admin ID and queue name
      const { data, error } = await supabase.functions.invoke(
        "create-qr-and-queue",
        {
          body: { queueName: queueName.trim() },
        },
      );

      if (error) {
        throw new Error(error.message || "Failed to invoke function");
      }

      console.log("Queue created successfully:", data);

      // Refresh the queue list to show the new queue
      const { data: updatedQueueData, error: updatedQueueError } =
        await supabase.from("Queue").select("*").eq("managed_by", admin.id);

      if (updatedQueueError) {
        throw updatedQueueError;
      }

      setQueue(updatedQueueData || []);
      setQueueName(""); // Reset the queue name input
    } catch (err: any) {
      setError(err.message || "Failed to create queue");
      console.error("Error creating queue:", err);
    } finally {
      setCreatingQueue(false);
    }
  };

  const handleDeleteQueue = async (queueId: string) => {
    if (!window.confirm("Are you sure you want to deactivate this queue?")) {
      return;
    }

    try {
      const { error } = await supabase
        .from("Queue")
        .update({
          is_active: false,
        })
        .eq("id", queueId);

      if (error) {
        setError(error.message);
        return;
      }

      // Refresh active queues
      if (admin) {
        const { data } = await supabase
          .from("Queue")
          .select("*")
          .eq("managed_by", admin.id)
          .eq("is_active", true);

        setQueue(data || []);
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRestoreQueue = async (queueId: string) => {
    try {
      const { error } = await supabase
        .from("Queue")
        .update({
          is_active: true,
        })
        .eq("id", queueId);

      if (error) {
        setError(error.message);
        return;
      }

      fetchInactiveQueues();

      if (admin) {
        const { data } = await supabase
          .from("Queue")
          .select("*")
          .eq("managed_by", admin.id)
          .eq("is_active", true);

        setQueue(data || []);
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/admin", { replace: true });
  };

  return (
    <Layout showNavigation={false}>
      <div className="min-h-screen bg-linear-to-br from-background via-orange-50/20 to-background py-10 px-4">
        <div className="max-w-7xl mx-auto space-y-8">
          {/* MAIN CONTENT CARD */}
          <div className="bg-white rounded-3xl shadow-2xl p-10 border border-primary/20">
            {/* Display loading indicator */}
            {loading && (
              <div className="flex justify-center items-center py-10">
                <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-primary"></div>
              </div>
            )}

            {/* Display error message */}
            {error && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl">
                <div className="flex items-center">
                  <svg
                    className="w-5 h-5 text-red-400 mr-2"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    ></path>
                  </svg>
                  <span className="text-red-700 font-medium">
                    Error: {error}
                  </span>
                </div>
              </div>
            )}

            {/* Top Section - Only show if not loading and no error */}
            {!loading && !error && (
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6 mb-10">
                <div>
                  <h2 className="text-3xl font-extrabold text-gray-900">
                    Your Queues
                  </h2>
                  <p className="text-gray-600 mt-2 font-medium">
                    Welcome back, {admin?.name}
                  </p>
                </div>

                <div className="flex gap-4 flex-wrap">
                  <button
                    onClick={handleLogout}
                    className="px-6 py-3 bg-linear-to-r from-gray-100 to-gray-50 hover:from-gray-200 hover:to-gray-100 rounded-xl transition-all font-semibold shadow-md hover:shadow-lg border border-gray-200"
                  >
                    Logout
                  </button>
                  <button
                    onClick={() => setShowConfirmDialog(true)}
                    className="inline-flex items-center gap-2 px-6 py-3 bg-linear-to-r from-primary via-orange-600 to-primary hover:from-orange-700 hover:via-orange-700 hover:to-orange-700 text-white rounded-xl transition-all font-semibold shadow-xl hover:shadow-2xl transform hover:scale-[1.02]"
                  >
                    New Queue
                  </button>
                  <button
                    onClick={() => {
                      fetchInactiveQueues();
                      setShowInactiveDialog(true);
                    }}
                    className="px-6 py-3 bg-gray-700 text-white rounded-xl font-semibold shadow-lg"
                  >
                    Inactive Queues
                  </button>
                </div>
              </div>
            )}

            {/* QUEUE LIST - Only show if not loading and no error */}
            {!loading && !error && (
              <>
                {queue.length === 0 ? (
                  <div className="text-center py-24">
                    <div className="w-20 h-20 mx-auto rounded-full bg-linear-to-br from-primary/20 to-primary/10 flex items-center justify-center mb-6 shadow-md">
                      <FontAwesomeIcon
                        icon={faClipboardList}
                        className="text-4xl text-primary"
                      />
                    </div>
                    <h3 className="text-2xl font-bold text-gray-800">
                      No queues yet
                    </h3>
                    <p className="text-gray-500 mt-3 font-medium">
                      Start by creating your first queue.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
                    {queue.map((item) => (
                      <div
                        key={item.id}
                        className="group bg-white border border-gray-200 rounded-3xl p-8 shadow-lg hover:shadow-2xl hover:border-primary/50 transition-all duration-300 transform hover:scale-[1.02]"
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex-1 mr-2">
                            <h3 className="text-xl font-bold text-gray-900 truncate">
                              {item.name || `Queue #${item.id}`}
                            </h3>
                            <p className="text-xs text-gray-500 mt-1 font-mono">
                              ID: {item.id}
                            </p>
                          </div>

                          <span
                            className={`text-xs px-4 py-2 rounded-full font-bold ${
                              item.status === "active"
                                ? "bg-linear-to-r from-green-400 to-green-500 text-white shadow-md"
                                : "bg-linear-to-r from-red-400 to-red-500 text-white shadow-md"
                            }`}
                          >
                            {item.status}
                          </span>
                        </div>

                        <p className="text-sm text-gray-500 mt-6 font-medium">
                          Created on {new Date(item.date).toLocaleDateString()}
                        </p>

                        <div className="mt-8 flex gap-3">
                          <button
                            onClick={() => navigate(`/admin/queue/${item.id}`)}
                            className="flex-1 py-3 rounded-xl bg-linear-to-r from-gray-100 to-gray-50 hover:from-primary/10 hover:to-primary/20 hover:text-primary transition-all text-sm font-bold shadow-md hover:shadow-lg border border-transparent hover:border-primary/30"
                          >
                            Manage Queue
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteQueue(item.id);
                            }}
                            className="flex-1 py-3 rounded-xl bg-linear-to-r from-red-50 to-red-100 hover:from-red-100 hover:to-red-200 text-red-600 transition-all text-sm font-bold shadow-md hover:shadow-lg"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ANALYTICS SECTION */}
          {queue.length > 0 && (
            <div className="bg-white rounded-3xl shadow-2xl p-10 border border-primary/20">
              {/* Header */}
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
                <div className="flex items-center gap-3">
                  <div className="w-14 h-14 rounded-2xl bg-linear-to-br from-primary/20 to-primary/10 flex items-center justify-center shadow-lg">
                    <FontAwesomeIcon
                      icon={faChartLine}
                      className="text-3xl text-primary"
                    />
                  </div>
                  <div>
                    <h2 className="text-3xl font-extrabold text-gray-900">
                      Analytics Dashboard
                    </h2>
                    <p className="text-gray-600 mt-1 font-medium">
                      Track your queue performance and ticket statistics
                    </p>
                  </div>
                </div>

                {/* Time Filter */}
                <div className="flex items-center gap-2 bg-gray-100 rounded-xl p-1.5">
                  <FontAwesomeIcon
                    icon={faCalendarAlt}
                    className="text-gray-500 mr-2"
                  />
                  <button
                    onClick={() => setTimeFilter("weekly")}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                      timeFilter === "weekly"
                        ? "bg-white text-primary shadow-md"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Weekly
                  </button>
                  <button
                    onClick={() => setTimeFilter("monthly")}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                      timeFilter === "monthly"
                        ? "bg-white text-primary shadow-md"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Monthly
                  </button>
                  <button
                    onClick={() => setTimeFilter("yearly")}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                      timeFilter === "yearly"
                        ? "bg-white text-primary shadow-md"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Yearly
                  </button>
                </div>
              </div>

              {/* Ticket Status Distribution */}
              <div className="mb-10">
                <h3 className="text-xl font-bold text-gray-900 mb-6">
                  Ticket Status Distribution
                </h3>
                <div className="grid gap-6 lg:grid-cols-2">
                  {/* Pie Chart */}
                  <div className="bg-linear-to-br from-blue-50 to-cyan-50 rounded-2xl p-6 border-2 border-blue-200">
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={[
                            { name: "Waiting", value: ticketAnalytics.waiting },
                            { name: "Done", value: ticketAnalytics.done },
                            { name: "Skipped", value: ticketAnalytics.skipped },
                            {
                              name: "Cancelled",
                              value: ticketAnalytics.cancelled,
                            },
                          ]}
                          cx="50%"
                          cy="50%"
                          labelLine={false}
                          label={({ name, value }) =>
                            `${name}: ${value} (${(((value || 0) / (ticketAnalytics.waiting + ticketAnalytics.serving + ticketAnalytics.done + ticketAnalytics.skipped + ticketAnalytics.cancelled || 1)) * 100).toFixed(0)}%)`
                          }
                          outerRadius={80}
                          fill="#8884d8"
                          dataKey="value"
                        >
                          <Cell fill="#22C55E" />
                          <Cell fill="#3B82F6" />
                          <Cell fill="#EF4444" />
                          <Cell fill="#6B7280" />
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Stats Cards */}
                  <div className="space-y-4">
                    <div className="bg-linear-to-br from-yellow-50 to-orange-50 rounded-2xl p-6 border-2 border-yellow-300 shadow-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-yellow-700 uppercase">
                            Waiting
                          </p>
                          <p className="text-4xl font-extrabold text-yellow-900 mt-2">
                            {ticketAnalytics.waiting}
                          </p>
                        </div>
                        <div className="w-16 h-16 rounded-full bg-yellow-500 flex items-center justify-center">
                          <FontAwesomeIcon
                            icon={faHourglassHalf}
                            className="text-3xl text-white"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="bg-linear-to-br from-blue-50 to-cyan-50 rounded-2xl p-6 border-2 border-blue-300 shadow-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-blue-700 uppercase">
                            Completed
                          </p>
                          <p className="text-4xl font-extrabold text-blue-900 mt-2">
                            {ticketAnalytics.done}
                          </p>
                        </div>
                        <div className="w-16 h-16 rounded-full bg-blue-500 flex items-center justify-center">
                          <FontAwesomeIcon
                            icon={faCheck}
                            className="text-3xl text-white"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-linear-to-br from-red-50 to-pink-50 rounded-2xl p-4 border-2 border-red-300 shadow-lg">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-xs font-semibold text-red-700 uppercase">
                              Skipped
                            </p>
                            <p className="text-2xl font-extrabold text-red-900 mt-1">
                              {ticketAnalytics.skipped}
                            </p>
                          </div>
                          <div className="w-10 h-10 rounded-full bg-red-500 flex items-center justify-center">
                            <FontAwesomeIcon
                              icon={faForward}
                              className="text-xl text-white"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="bg-linear-to-br from-gray-50 to-slate-50 rounded-2xl p-4 border-2 border-gray-300 shadow-lg">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-xs font-semibold text-gray-700 uppercase">
                              Cancelled
                            </p>
                            <p className="text-2xl font-extrabold text-gray-900 mt-1">
                              {ticketAnalytics.cancelled}
                            </p>
                          </div>
                          <div className="w-10 h-10 rounded-full bg-gray-500 flex items-center justify-center">
                            <FontAwesomeIcon
                              icon={faTimesCircle}
                              className="text-xl text-white"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Queue Growth Chart */}
              <div>
                <h3 className="text-xl font-bold text-gray-900 mb-6">
                  Queue Growth Trend
                </h3>
                <div className="bg-linear-to-br from-purple-50 to-indigo-50 rounded-2xl p-6 border-2 border-purple-200">
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={queueGrowthData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis
                        dataKey="name"
                        stroke="#6B7280"
                        style={{ fontSize: "12px" }}
                      />
                      <YAxis stroke="#6B7280" style={{ fontSize: "12px" }} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "white",
                          border: "2px solid #E5E7EB",
                          borderRadius: "12px",
                          boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
                        }}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="tickets"
                        stroke="#8B5CF6"
                        strokeWidth={3}
                        dot={{ fill: "#8B5CF6", r: 6 }}
                        activeDot={{ r: 8 }}
                        name="Total Tickets"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation Dialog */}
      {showConfirmDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 border border-primary/20 transform transition-all animate-in fade-in zoom-in duration-200">
            <div className="text-center">
              <div className="mx-auto h-16 w-16 rounded-full bg-linear-to-br from-primary to-orange-700 flex items-center justify-center mb-6 shadow-xl">
                <FontAwesomeIcon
                  icon={faClipboardList}
                  className="text-2xl text-white"
                />
              </div>
              <h3 className="text-2xl font-extrabold text-gray-900 mb-3">
                Create New Queue
              </h3>
              <p className="text-gray-600 mb-6 font-medium leading-relaxed">
                Enter a name for your new queue. A unique ID and QR code will be
                generated automatically.
              </p>

              {/* Queue Name Input */}
              <div className="mb-6 text-left">
                <label className="text-sm font-semibold text-gray-700 block mb-2">
                  Queue Name
                </label>
                <input
                  type="text"
                  value={queueName}
                  onChange={(e) => setQueueName(e.target.value)}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-4 focus:ring-primary/20 focus:border-primary transition-all bg-white text-gray-900 placeholder:text-gray-400"
                  placeholder="e.g., Cashier 1, Registration, Records"
                  required
                />
              </div>

              <div className="flex gap-4">
                <button
                  onClick={() => {
                    setShowConfirmDialog(false);
                    setQueueName("");
                  }}
                  className="flex-1 px-6 py-3 border-2 border-gray-300 rounded-xl hover:bg-gray-50 transition-all font-semibold shadow-md hover:shadow-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateQueue}
                  disabled={creatingQueue || !queueName.trim()}
                  className="flex-1 px-6 py-3 bg-linear-to-r from-primary via-orange-600 to-primary hover:from-orange-700 hover:via-orange-700 hover:to-orange-700 text-white rounded-xl transition-all font-semibold shadow-xl hover:shadow-2xl disabled:opacity-50 transform hover:scale-[1.02]"
                >
                  {creatingQueue ? "Creating..." : "Create Queue"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showInactiveDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white rounded-3xl p-8 max-w-lg w-full">
            <h2 className="text-2xl font-bold mb-6">Inactive Queues</h2>

            {inactiveQueues.length === 0 ? (
              <p>No inactive queues found.</p>
            ) : (
              <div className="space-y-4">
                {inactiveQueues.map((item) => (
                  <div
                    key={item.id}
                    className="border rounded-xl p-4 flex justify-between items-center"
                  >
                    <div>
                      <h3 className="font-bold">{item.name}</h3>
                      <p className="text-sm text-gray-500">ID: {item.id}</p>
                    </div>

                    <button
                      onClick={() => handleRestoreQueue(item.id)}
                      className="px-4 py-2 bg-green-500 text-white rounded-lg"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => setShowInactiveDialog(false)}
              className="mt-6 w-full py-3 bg-gray-200 rounded-xl"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </Layout>
  );
};

export default AdminDashboard;

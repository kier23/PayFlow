import React, { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QrCode, Camera, Info, CheckCircle } from "lucide-react";
import { BrowserQRCodeReader } from "@zxing/browser";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLightbulb, faTicket } from "@fortawesome/free-solid-svg-icons";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getGuestId } from "../lib/getGuestId";

const EndUserPage: React.FC = () => {
  const navigate = useNavigate();
  const [queueId, setQueueId] = useState("");
  const [scanning, setScanning] = useState(false);
  const [hasActiveTicket, setHasActiveTicket] = useState(false);
  const [activeTicketQueueId, setActiveTicketQueueId] = useState<string | null>(
    null,
  );
  const [showTicketModal, setShowTicketModal] = useState(false);
  const [userTickets, setUserTickets] = useState<
    Array<{
      queue_id: string;
      ticket_number: number;
      status: string;
      purpose?: string;
    }>
  >([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const codeReader = useRef<BrowserQRCodeReader | null>(null);
  const controlsRef = useRef<any>(null);
  const hasScannedRef = useRef(false);

  // Check for active tickets on mount and when page gains focus
  useEffect(() => {
    const checkActiveTicket = async () => {
      const guestId = getGuestId();

      try {
        const { data } = await supabase
          .from("Queue_Tickets")
          .select("queue_id, status")
          .eq("guest_id", guestId)
          .in("status", ["waiting", "serving"])
          .limit(1);

        if (data && data.length > 0) {
          setHasActiveTicket(true);
          setActiveTicketQueueId(data[0].queue_id.toString());
        } else {
          setHasActiveTicket(false);
          setActiveTicketQueueId(null);
        }
      } catch (err) {
        console.error("Error checking active ticket:", err);
      }
    };

    checkActiveTicket();

    // Refresh when page gains focus
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkActiveTicket();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
    };
  }, []);

  // Fetch all user tickets for the modal
  const fetchUserTickets = async () => {
    const guestId = getGuestId();

    try {
      const { data, error } = await supabase
        .from("Queue_Tickets")
        .select("queue_id, ticket_number, status, purpose")
        .eq("guest_id", guestId)
        .in("status", ["waiting", "serving"])
        .order("created_at", { ascending: false });

      if (error) throw error;

      if (data && data.length > 0) {
        setUserTickets(data);
        setShowTicketModal(true);
      } else {
        alert("No active tickets found.");
      }
    } catch (err) {
      console.error("Error fetching tickets:", err);
      alert("Failed to load tickets.");
    }
  };

  useEffect(() => {
    codeReader.current = new BrowserQRCodeReader();

    return () => {
      try {
        controlsRef.current?.stop();
      } catch (err) {
        console.warn("Cleanup scanner stop error:", err);
      } finally {
        controlsRef.current = null;
      }
    };
  }, []);

  const startScanning = async () => {
    if (!codeReader.current) return;

    hasScannedRef.current = false;
    setScanning(true);

    setTimeout(async () => {
      if (!videoRef.current || !codeReader.current) return;

      try {
        const reader = codeReader.current;

        controlsRef.current = await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (result) => {
            if (result && !hasScannedRef.current) {
              hasScannedRef.current = true;

              const raw = result.getText().trim();
              console.log("Scanned QR raw:", raw);

              let scannedQueueId = raw;

              if (raw.includes("/queue/")) {
                const parts = raw.split("/queue/");
                scannedQueueId = parts[1]?.split("/")[0] || raw;
              }

              stopScanning();

              setTimeout(() => {
                navigate(`/queue/${scannedQueueId}`);
              }, 200);
            }
          },
        );
      } catch (error) {
        console.error("Scanner error:", error);
        alert("Camera failed to start");
        setScanning(false);
      }
    }, 100);
  };

  const stopScanning = () => {
    try {
      controlsRef.current?.stop();
    } catch (err) {
      console.warn("Scanner stop error:", err);
    } finally {
      controlsRef.current = null;
      setScanning(false);
    }
  };

  const handleSubmit = () => {
    if (!queueId) return alert("Please enter or scan a Queue ID");
    navigate(`/queue/${queueId}`);
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-background via-orange-50/30 to-background">
      {/* Header */}
      <header className="bg-white/90 backdrop-blur-xl shadow-lg sticky top-0 z-50 border-b border-primary/20">
        <div className="container mx-auto px-4 py-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl from-primary flex items-center justify-center shadow-md">
                <img
                  src="/PayFlow-Logo_transparent.png"
                  alt="PayFlow Logo"
                  className="w-full h-full object-cover"
                />
              </div>
              <h1 className="text-3xl md:text-4xl font-extrabold bg-linear-to-r from-primary via-orange-600 to-black bg-clip-text text-transparent">
                PayFlow PSU
              </h1>
            </div>

            {/* Login Button - Top Right */}
            <button
              onClick={() => navigate("/admin")}
              className="px-6 py-2.5 bg-linear-to-r from-primary via-orange-600 to-primary text-white rounded-xl font-semibold shadow-md hover:shadow-lg transition-all hover:scale-105 whitespace-nowrap"
            >
              Login
            </button>
          </div>
        </div>
      </header>

      {/* Main Content - Responsive Layout */}
      <main className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8 max-w-7xl mx-auto">
          {/* Right Column - QR Scanner & Input Combined (Full width on mobile, 1/3 on PC) - Moved to top on mobile */}
          <div className="lg:col-span-1 order-first lg:order-last">
            <Card className="border-0 shadow-2xl hover:shadow-3xl transition-all duration-300 bg-linear-to-br from-white via-orange-50/50 to-white backdrop-blur-sm rounded-3xl overflow-hidden sticky top-24">
              <CardContent className="p-8 flex flex-col gap-8">
                {/* QR Scanner Section */}
                <div className="flex flex-col gap-5">
                  <div className="flex items-center gap-3 text-xl font-bold text-gray-800">
                    <div className="p-2 bg-linear-to-br from-primary/20 to-primary/10 rounded-xl">
                      <Camera className="w-6 h-6 text-primary" />
                    </div>
                    <span>Scan QR Code</span>
                  </div>

                  {scanning ? (
                    <>
                      <div className="relative rounded-2xl overflow-hidden border-4 border-primary/30 shadow-lg">
                        <video
                          ref={videoRef}
                          className="w-full aspect-square object-cover"
                          autoPlay
                          playsInline
                          muted
                        />
                        <div className="absolute inset-0 border-4 border-primary rounded-2xl animate-pulse"></div>
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className="w-3/4 h-3/4 border-2 border-white/50 rounded-lg"></div>
                        </div>
                      </div>
                      <Button
                        variant="destructive"
                        onClick={stopScanning}
                        className="w-full font-bold py-6 text-base shadow-lg hover:shadow-xl transition-all"
                        size="lg"
                      >
                        Stop Scanning
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        onClick={startScanning}
                        className="w-full font-bold py-6 text-base bg-linear-to-r from-primary via-orange-600 to-primary hover:from-orange-700 hover:via-orange-700 hover:to-orange-700 shadow-xl hover:shadow-2xl transition-all transform hover:scale-[1.02]"
                        size="lg"
                      >
                        <Camera className="w-5 h-5 mr-2" />
                        Scan Queue QR
                      </Button>
                    </>
                  )}
                </div>

                {/* Divider */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-200"></div>
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-linear-to-r from-transparent via-white px-4 text-gray-500 font-semibold">
                      or
                    </span>
                  </div>
                </div>

                {/* Queue ID Input Section */}
                <div className="flex flex-col gap-5">
                  <div className="flex items-center gap-3 text-xl font-bold text-gray-800">
                    <div className="p-2 bg-linear-to-br from-primary/20 to-primary/10 rounded-xl">
                      <QrCode className="w-6 h-6 text-primary" />
                    </div>
                    <span>Enter Queue ID</span>
                  </div>

                  <Input
                    placeholder="Type your Queue ID here..."
                    value={queueId}
                    onChange={(e) => setQueueId(e.target.value)}
                    className="h-14 text-base border-3 border-primary/30 focus:border-primary focus:ring-4 focus:ring-primary/20 rounded-xl font-medium shadow-sm"
                  />

                  <Button
                    onClick={handleSubmit}
                    className="w-full font-bold py-6 text-base bg-linear-to-r from-primary via-orange-600 to-primary hover:from-orange-700 hover:via-orange-700 hover:to-orange-700 shadow-xl hover:shadow-2xl transition-all transform hover:scale-[1.02]"
                    size="lg"
                  >
                    <CheckCircle className="w-5 h-5 mr-2" />
                    Join Queue
                  </Button>

                  {/* My Ticket Button */}
                  {hasActiveTicket && activeTicketQueueId && (
                    <Button
                      onClick={fetchUserTickets}
                      className="w-full font-bold py-6 text-base bg-linear-to-r from-green-600 via-emerald-600 to-green-600 hover:from-emerald-700 hover:via-emerald-700 hover:to-emerald-700 shadow-xl hover:shadow-2xl transition-all transform hover:scale-[1.02] text-white"
                      size="lg"
                    >
                      <FontAwesomeIcon icon={faTicket} className="mr-2" />
                      My Active Ticket{userTickets.length > 1 ? "s" : ""}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Left Column - Introduction & Rules (Full width on mobile, 2/3 on PC) */}
          <div className="lg:col-span-2 space-y-6">
            {/* Introduction Card */}
            <Card className="border-0 shadow-xl hover:shadow-2xl transition-all duration-300 bg-linear-to-br from-white to-orange-50/30 backdrop-blur-sm rounded-3xl overflow-hidden">
              <CardContent className="p-8 flex flex-col gap-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-linear-to-br from-primary/10 to-primary/20 rounded-2xl shadow-inner">
                    <Info className="w-7 h-7 text-primary" />
                  </div>
                  <h2 className="text-3xl font-bold text-gray-800">
                    Introduction
                  </h2>
                </div>

                <p className="text-gray-700 leading-relaxed text-base md:text-lg">
                  PayFlow PSU is a digital queuing system designed to reduce
                  long lines and improve the payment experience at Palawan State
                  University by allowing users to join queues through QR
                  scanning or queue ID input. Simply scan the QR code displayed
                  at the payment counter or manually enter your queue ID to get
                  started.
                </p>

                <div className="bg-linear-to-r from-primary/10 via-orange-100/50 to-primary/10 rounded-2xl p-5 border border-primary/20 shadow-sm">
                  <p className="text-sm text-gray-800 font-semibold flex items-center gap-2">
                    <FontAwesomeIcon
                      icon={faLightbulb}
                      className="text-yellow-600"
                    />{" "}
                    Quick Tip: Scanning the QR code is faster and reduces
                    errors!
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Rules Card */}
            <Card className="border-0 shadow-xl hover:shadow-2xl transition-all duration-300 bg-linear-to-br from-white to-green-50/30 backdrop-blur-sm rounded-3xl overflow-hidden">
              <CardContent className="p-8 flex flex-col gap-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-linear-to-br from-primary/10 to-primary/20 rounded-2xl shadow-inner">
                    <CheckCircle className="w-7 h-7 text-primary" />
                  </div>
                  <h2 className="text-3xl font-bold text-gray-800">
                    Guidelines
                  </h2>
                </div>

                <ul className="space-y-4">
                  {[
                    {
                      en: "Scan the QR code on the screen or enter the Queue ID to join.",
                      tl: "I-scan ang QR code sa screen o ilagay ang Queue ID para makasali sa pila.",
                    },
                    {
                      en: "Fill out the form with your information.",
                      tl: "Sagutan ang form gamit ang iyong impormasyon.",
                    },
                    {
                      en: "You will receive your queue number.",
                      tl: "Makakatanggap ka ng iyong queue number.",
                    },
                    {
                      en: "You may leave and return, but please be back before your number is called.",
                      tl: "Maaari kang umalis at bumalik, ngunit siguraduhing naroon ka bago tawagin ang iyong numero.",
                    },
                    {
                      en: "The queue advances every 5 seconds per number, and you can track the current number on the website.",
                      tl: "Umaabante ang pila kada 5 segundo bawat numero, at maaari mong subaybayan ang kasalukuyang numero sa website.",
                    },
                  ].map((guide, index) => (
                    <li
                      key={index}
                      className="flex items-start gap-4 p-4 rounded-2xl bg-white/80 hover:bg-white transition-all shadow-sm hover:shadow-md"
                    >
                      <span className="shrink-0 w-8 h-8 bg-linear-to-br from-primary to-orange-600 text-white rounded-full flex items-center justify-center text-sm font-bold shadow-md">
                        {index + 1}
                      </span>

                      <div className="leading-relaxed">
                        <p className="text-gray-800 font-medium">{guide.en}</p>
                        <p className="text-sm text-gray-500 italic mt-1">
                          {guide.tl}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white/90 backdrop-blur-xl border-t border-primary/20 mt-16 py-8 shadow-lg">
        <div className="container mx-auto px-4 text-center">
          <p className="text-gray-600 text-sm font-medium">
            © {new Date().getFullYear()} PayFlow - Queue Management System
          </p>
          <p className="text-gray-500 text-xs mt-2 font-medium">
            Palawan State University
          </p>
        </div>
      </footer>

      {/* Ticket Selection Modal */}
      {showTicketModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full p-6 md:p-8 border border-primary/20 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-bold bg-linear-to-r from-primary via-orange-600 to-black bg-clip-text text-transparent">
                Select Ticket to Track
              </h3>
              <button
                onClick={() => setShowTicketModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="space-y-3">
              {userTickets.map((ticket, index) => (
                <button
                  key={index}
                  onClick={() => {
                    navigate(`/queue/${ticket.queue_id}/status`);
                    setShowTicketModal(false);
                  }}
                  className="w-full text-left p-4 md:p-5 bg-linear-to-br from-white to-orange-50/30 border-2 border-gray-200 rounded-2xl hover:border-primary hover:shadow-lg transition-all group"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-2xl font-black text-primary">
                          #{ticket.ticket_number}
                        </span>
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-bold ${
                            ticket.status === "serving"
                              ? "bg-green-100 text-green-800"
                              : "bg-yellow-100 text-yellow-800"
                          }`}
                        >
                          {ticket.status === "serving"
                            ? "🔔 Serving Now"
                            : "⏳ Waiting"}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 font-medium">
                        Queue ID:{" "}
                        <span className="font-mono font-bold">
                          {ticket.queue_id}
                        </span>
                      </p>
                      {ticket.purpose && (
                        <p className="text-xs text-gray-500 mt-1">
                          Purpose: {ticket.purpose}
                        </p>
                      )}
                    </div>
                    <div className="ml-3 text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                      <svg
                        className="w-6 h-6"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5l7 7-7 7"
                        />
                      </svg>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowTicketModal(false)}
              className="w-full mt-6 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-semibold transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default EndUserPage;

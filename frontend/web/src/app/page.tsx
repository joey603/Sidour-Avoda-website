"use client";
import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/auth";

export default function Home() {
  const [name, setName] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const me = await fetchMe();
        if (me?.full_name) setName(me.full_name);
      } catch {
        // ignore
      }
    })();
  }, []);

  return (
    <div className="min-h-screen p-6 flex items-center justify-center">
      <h1 className="text-2xl font-semibold text-center">
        ברוך הבא{ name ? ", " : "" }<span className="font-bold" style={{ color: '#00A8E0' }}>{name}</span>
      </h1>
    </div>
  );
}

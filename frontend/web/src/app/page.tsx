"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/auth";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    fetchMe().then((me) => {
      if (me) {
        router.replace(me.role === "director" ? "/director" : "/worker");
      } else {
        router.replace("/login");
      }
    });
  }, [router]);
  return null;
}

"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const ChatBot = dynamic(() => import("./ChatBot").then((module) => module.ChatBot), {
  ssr: false,
});

export function SiteChatBot() {
  const pathname = usePathname();
  const [hasLoadedChat, setHasLoadedChat] = useState(false);
  const shouldHide =
    pathname === "/book" ||
    pathname === "/bookdemo" ||
    pathname.startsWith("/book/") ||
    pathname.startsWith("/quote");

  useEffect(() => {
    if (!shouldHide) setHasLoadedChat(true);
  }, [shouldHide]);

  // Booking pages have their own help actions. Keep the chat implementation
  // out of their initial bundle. After chat has loaded, let its own route gate
  // hide it so client navigation preserves the visitor's conversation.
  if (shouldHide && !hasLoadedChat) {
    return null;
  }

  return <ChatBot />;
}

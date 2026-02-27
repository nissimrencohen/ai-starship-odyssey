import React, { useEffect, useRef } from 'react';
import { Terminal, User, Bot } from 'lucide-react';

export interface ChatMessage {
    sender: 'user' | 'rachel';
    text: string;
    timestamp: Date;
}

interface ChatLogProps {
    messages: ChatMessage[];
}

export function ChatLog({ messages }: ChatLogProps) {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    return (
        <div className="flex flex-col h-full overflow-hidden w-full">
            <div className="flex items-center justify-between px-2 py-2 mb-2">
                <div className="flex items-center space-x-2">
                    <Terminal className="w-4 h-4 text-purple-400" />
                    <span className="text-xs font-bold uppercase tracking-widest text-neutral-400">Conversational Log</span>
                </div>
                <div className="text-[10px] font-mono text-neutral-600">v7.7.0-STABLE</div>
            </div>

            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar scroll-smooth"
            >
                {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center opacity-20 italic text-sm text-neutral-500">
                        Awaiting transmission...
                    </div>
                ) : (
                    messages.map((msg, idx) => (
                        <div
                            key={idx}
                            className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2 duration-300 w-full`}
                        >
                            <div className={`flex items-center space-x-2 mb-1.5 opacity-50`}>
                                {msg.sender === 'rachel' ? (
                                    <>
                                        <Bot className="w-3.5 h-3.5 text-purple-400" />
                                        <span className="text-[10px] font-bold uppercase tracking-tighter text-purple-400">Rachel</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-[10px] font-bold uppercase tracking-tighter text-blue-400">Pilot</span>
                                        <User className="w-3.5 h-3.5 text-blue-400" />
                                    </>
                                )}
                                <span className="text-[9px] font-mono text-neutral-600">
                                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                            </div>
                            <div
                                className={`
                  max-w-[95%] px-4 py-3 rounded-xl text-sm leading-relaxed font-medium shadow-lg
                  ${msg.sender === 'rachel'
                                        ? 'bg-purple-500/10 text-purple-100 border border-purple-500/20 rounded-tl-none shadow-[0_0_20px_rgba(168,85,247,0.15)]'
                                        : 'bg-blue-500/10 text-blue-100 border border-blue-500/20 rounded-tr-none shadow-[0_0_20px_rgba(59,130,246,0.15)]'
                                    }
                `}
                            >
                                {msg.text}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

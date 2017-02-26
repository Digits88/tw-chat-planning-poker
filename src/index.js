import Promise from "bluebird";
import winston from "winston";
import TeamworkChat from "@teamwork/tw-chat";
import { pull } from "lodash";
import Session from "./Session";

winston.add(winston.transports.File, { filename: "poker.log" });

export default TeamworkChat.fromAuth("http://1486461376533.teamwork.com", "dJOs9ljikVpGIQdJux6QugXr49Zq6V-127607").then(bot => {
    const activator = new RegExp(`^@${bot.handle} poker(.+)`);
    const sessions = [];

    winston.info(`starting poker bot with handle @${bot.handle}`);
    return bot.on("message:mention", (room, message) => {
        winston.info(`mention in room ${room.id} by @${message.author.handle}: ${message.content}`);

        Promise.try(async () => {
            if(message.content.match(activator)) {
                const moderator = message.author;

                winston.info(`new poker game requested`);

                const handles = RegExp.$1.split(" ").map(handle => handle.trim().replace("@", "")).filter(handle => handle);

                if(!handles.length || handles.length < 1) {
                    throw new Error(`Sorry @${moderator.handle}, please supply at least one other to plan the sprint.`);
                }

                // Ensure all the user's exist.
                await Promise.all(handles.map(handle => bot.getPersonByHandle(handle)));

                // To start a new poker game, create a room with the moderator and the bot
                const sessionRoom = await bot.createRoomWithHandles(
                    [bot.handle, moderator.handle, ...handles], 
                    ":wave: Welcome to Sprint Planning Poker. Use this room for discussion on tasks."
                );

                winston.info(`new room created for poker game ${sessionRoom.id}`);

                const session = new Session(bot, sessionRoom, moderator);

                sessions.push(session);
                session.on("complete", () => pull(sessions, session));

                await session.init();
            }
        }).catch(error => {
            room.sendMessage(error.message);
        });
    });
});
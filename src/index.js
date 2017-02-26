import winston from "winston";
import { stripIndent } from "common-tags";
import TeamworkChat from "@teamwork/tw-chat";
import Session from "./Session";

winston.add(winston.transports.File, { filename: "poker.log" });

export default TeamworkChat.fromAuth("http://1486461376533.teamwork.com", "dJOs9ljikVpGIQdJux6QugXr49Zq6V-127607").then(async bot => {
    // const activator = `@${bot.handle} poker`;

    // winston.info(`starting poker bot with handle @${bot.handle}`);
    // return bot.on("message:mention", async (room, message) => {
    //     winston.info(`mention in room ${room.id} by @${message.author.handle}: ${message.content}`);

    //     if(message.content.startsWith(activator)) {
    //         const moderator = message.author;

    //         winston.info(`new poker game requested`);

    //         const name = `Session #${Math.random() * 1000}`;

    //         // To start a new poker game, create a room with the moderator and the bot
    //         const sessionRoom = await bot.createRoomWithHandles([bot.handle, message.author.handle, "michael"], stripIndent`
    //             Hi @${message.author.handle}, you've started a new game of sprint planning poker. Please add 
    //             the users you wish to participate in the planning to this room then ping me to
    //             start ("@${bot.handle} start").
    //         `);

    //         winston.info(`new room created for poker game ${sessionRoom.id}`);

    //         await sessionRoom.updateTitle("Planning poker room: " + name);

    //         const session = new Session(name, sessionRoom, moderator, [{
    //             id: 1,
    //             title: "Hello world!",
    //             link: "http://google.com"
    //         }]);

    //         await session.execute();
    //     }
    // });
    
    const session = new Session("Poker session", bot, await bot.getRoom(3583), await bot.getPersonByHandle("adrian"));

    return session.init();
});
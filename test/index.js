import winston from "winston";
import Promise from "bluebird";
import TeamworkChat from "@teamwork/tw-chat";
import poker from "../src";

// winston.add(winston.transports.File, { filename: "poker.log" });

// poker.then(() => {
//     TeamworkChat.fromAuth("http://1486461376533.teamwork.com", "nw3Ujj83Gcz76vcOEIitdti5rfsPW-120606").then(chat => {
//         return [chat, chat.impersonateByHandle("michael")];
//     }).spread((chat, michael) => {
//         return Promise.try(async () => {
//             // Start the poker in a company room
//             const companyRoom = await chat.getRoomByTitle("Poker");

//             // Start the poker
//             await companyRoom.sendMessage("@bot poker");
//         }).finally(() => {
//             chat.close();
//             michael.close();
//         });
//     });
// });
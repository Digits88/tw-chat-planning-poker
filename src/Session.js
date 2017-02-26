import { EventEmitter } from "events";
import winston from "winston";
import moment from "moment";
import Promise, { CancellationError } from "bluebird";
import { prompt } from "@teamwork/tw-chat/src/util";
import { stripIndent } from "common-tags";
import { without } from "lodash";
import Round from "./Round";

const ICON_ANNOUNCEMENT = ":microphone:";
const ICON_WAITING = ":hourglass_flowing_sand:";
const ICON_COMPLETE = ":white_check_mark:";
const ICON_CELEBRATE = ":shipit:";
const ICON_QUESTION = ":question:";
const ICON_ERROR = ":x:";
const ICON_HELP = ":sos:";
const ICON_MODERATOR = ":wolf:";

export default class Session extends EventEmitter {
    room;
    rounds;
    moderator;

    constructor(name, admin, room, moderator) {
        super();
        
        this.name = name;
        this.admin = admin;
        this.room = room;
        this.moderator = moderator;
        this.rounds = [];

        winston.info(`create new session: ${name}`, { room: room.id, moderator: moderator.id });

        this.mentionCommands = new RegExp(`^@${room.api.user.handle} (help|start|skip|pass|plan|estimate|status|add)(.*)`);
        this.directCommands = new RegExp(`^@${room.api.user.handle} (help|stop)(.*)`);

        // Listen for commands in the room
        this.room.on("message:mention", this.handleMention.bind(this));

        // Listen for commands from the user
        this.room.people.forEach(person => person.on("message:received", this.handleDirectMessage.bind(person, this)));
        // TODO: Handle newly added people to the room
    }

    async init() {
        // Send the welcome message to the room and participating users.
        await this.broadcast(`:wave: Welcome to Sprint Planning Poker. Use this room for discussion on tasks.`);
        await this.help();

        await this.broadcast(
            `To begin, @${this.moderator.handle} (the moderator) must select a tasklist to plan. ` +
            `*Example:* \`@bot plan http://digitalcrew.teamwork.com/#tasklist/124424\``
        );

        await Promise.delay(2000);

        await this.broadcastDirect(person =>
            `Hi @${person.handle}, you've been included in Sprint Planning Poker with ` + 
            `${this.participants.map(person => person.firstName).join(", ")}. I'll be asking ` +
            `you for estimates soon when the planning starts.`
        );
    }

    handleMention(message) {
        winston.info("session room received mention", { message: message.content, author: message.author.id });
        return Promise.try(() => {
            if(message.content.match(this.mentionCommands)) {
                const command = RegExp.$1;
                const args = RegExp.$2.trim();

                winston.info(`mention command: ${command} ${args}`);

                switch(command) {
                    case "plan":
                        // Ensure we have a tasklist
                        const tasklist = args.trim();

                        if(!tasklist) {
                            throw new CommandError("Please provide a tasklist to plan.")
                        }

                        // https://1486461376533.teamwork.com/index.cfm#tasklists/434312
                        if(!tasklist.match(/https?:\/\/([a-zA-Z0-9_\-]+)\.teamwork.com\/index\.cfm#tasklists\/(\d+)/)) {
                            throw new CommandError("Is that a tasklist URL? I don't recognize it.");
                        }

                        return this.plan(RegExp.$1, parseInt(RegExp.$2));
                    break;

                    case "estimate":
                        if(message.author !== this.moderator) {
                            throw new Error(`Sorry @${this.message.author}, only the moderator can set the estimate.`);
                        }

                        if(!this.currentRound) {
                            throw new Error(`Sorry, you can't estimate nothing. Please select a tasklist to plan and get started.`);
                        }

                        if(!args) {
                            throw new Error(`Please provide an estimate. Example: 0.5, 1, 2, 10`);
                        }

                        // Manually set the estimates
                        return this.estimate(parseEstimate(args)).then(() => {
                            // Cancel the await estimates
                            this.currentRound.cancelAllEstimates();

                            // Go to the next round
                            return this.nextRound();
                        });
                    break;

                    default:
                        return this[command]();
                }
            } else {
                winston.info("unknown message command", { message: message.content, author: message.author.id });
                throw new CommandError(`I don't understand your input.`);
            }
        }).catch(error => {
            winston.error(error, { message: message.content, room: this.room.id });
            return this.broadcastError(error);
        });
    }

    handleDirectMessage(person, message) {
        winston.info("private message", { person: person.id, message: message.content });
    }

    async start() {
        if(!this.rounds.length) {
            throw new Error([
                "Can't start sprint planning without tasks. Please ",
                `provide a tasklist with like "@${this.admin.handle} plan <tasklist>`
            ].join(""));
        }

        this.currentRoundIndex = 0;
        this.planning = true;
        this.startTime = moment();

        while(this.currentRound) {
            winston.info("moving to the next round");
            let result;

            try {
                result = await this.currentRound.execute();
            } catch(err) {
                // If the moderator manually sets the esimate, we cancel the currently executing round
                if(err instanceof CancellationError) {
                    continue;
                } else throw err;
            } 

            await this.broadcastAll(`${ICON_COMPLETE} Voting complete. Average estimate: **${result.average}**`);
            await this.broadcast(formatResultTable(result.estimates));
            await this.broadcastAll(`${ICON_WAITING} Awaiting moderator to select final estimate.`);

            const final = await prompt(this.moderator, {
                message: `${ICON_QUESTION} Please select final estimate for task #${this.currentRound.task.id}. Average was ${result.average}.`,
                validate: "float"
            });

            await this.broadcastAll(`${ICON_ANNOUNCEMENT} Moderator has picked final estimate of ${final} hours.`);
            await this.estimate(final);
            await this.nextRound();
        }

        this.endTime = moment();
        this.planning = false;

        await this.broadcast(`${ICON_CELEBRATE} Sprint planning complete.`);

        this.emit("complete");
    }

    async plan(installation, tasklist) {
        // Get the tasks. Once we get the whole API together in one module, this will be awesome
        tasklist = (await this.admin.api.request(`/tasklists/${tasklist}.json`))["todo-list"];
        const tasks = (await this.admin.api.request(`/tasklists/${parseInt(tasklist.id)}/tasks.json`))["todo-items"];

        if(!tasks || !tasks.length) {
            throw new Error("Your tasklist doesn't seem to have any tasks!");
        }

        this.rounds = tasks.map(task => new Round(this, {
            id: task.id,
            installation,
            estimate: task["estimated-minutes"],
            title: task.content,
            link: `https://${installation}.teamwork.com/index.cfm#tasks/${task.id}`
        }));

        await this.broadcast(
            `${ICON_ANNOUNCEMENT} Okay, we're going to plan the **${tasklist.name}** tasklist. ` + 
            `${ICON_WAITING} There are ${tasks.length} tasks to plan. To start, @${this.moderator.handle} ping me to start (\`@${this.admin.handle} start\`).`
        );
    }

    async estimate(estimate) {
        if(!this.currentRound) {
            throw new Error("There is no current task to set the estimate for, sorry!");
        }

        this.currentRound.end();

        const task = this.currentRound.task;

        await this.broadcast(`${ICON_COMPLETE} Updating task #${task.id} with an estimate of ${estimate} hr(s).`);
    }

    async nextRound() {
        const i = this.currentRoundIndex++;
        const len = this.rounds.length;
        await this.broadcast(`${ICON_ANNOUNCEMENT} Moving to next task (#${i + 1} of ${len}, ${len - i} to go).`);
    }

    help() {
        const handle = `@${this.admin.handle}`;
        return this.broadcast(stripIndent`
            ${ICON_HELP} **Sprint Poker Planning Help**
            * *"${handle} plan <tasklist url>"* to set the tasklist to plan.
            * *"${handle} add <handle>"* to add a user to the planning.
            * *"${handle} start"* to begin the planning.
            * *"${handle} skip"* to skip planning a task.
            * *"${handle} pass"* to push the task to the end of the planning queue.
            * *"${handle} estimate <hours>"* to manually set the estimate (only the moderator, @${this.moderator.handle}, can do this).
            * *"${handle} vote <hours>"* to publically vote your estimate during a round.
            * *"${handle} status"* to get who is still current estimating.
        `);
    }

    status() {
        let output = [
            `${ICON_MODERATOR} ${this.moderator.firstName} is the moderator.`,
            `${ICON_COMPLETE} ${this.completedRounds.length} of ${this.rounds.length} tasks estimated.`
        ];

        if(this.currentRound) {
            const estimating = this.currentRound.getEstimatingUsers();

            output.push(`${ICON_ANNOUNCEMENT} Current task: [${this.currentRound.task.title}](${this.currentRound.task.link})`);

            if(estimating.length) {
                output.push(`${ICON_WAITING} ${estimating.map(p => "@" + p.handle).join(", ")} are still estimating.`);
            } 
        }

        return this.room.sendMessage(output.join("\n"));
    }

    broadcast(message) {
        if(Array.isArray(message)) {
            message = message.join("");
        }

        winston.info("broadcasting: " + message);
        return this.room.sendMessage(message);
    }

    broadcastDirect(message) {
        return Promise.map(this.participants, person => {
            message = typeof message === "function" ? message(person) : message;

            if(Array.isArray(message)) {
                message = message.join("");
            }

            return person.sendMessage(message);
        });
    }

    broadcastError(error) {
        return this.broadcast(`${ICON_ERROR} ${error.message}`);
    }

    broadcastAll(message) {
        winston.info("broadcast all");
        return Promise.all([
            this.broadcast(message),
            this.broadcastDirect(message)
        ]);
    }

    get participants() {
        return without(this.room.people, this.admin);
    }

    get currentRound() {
        return this.planning ? this.rounds[this.currentRoundIndex] : null;
    }

    get completedRounds() {
        return this.rounds.filter(round => round.complete);
    }
}

class CommandError extends Error {
    constructor(message, offender) {
        super();
        this.message = message;
        this.offender = offender;
    }
}

function parseEstimate(input) {
    const estimate = parseFloat(input);

    if(isNaN(estimate)) {
        throw new Error(`Invalid estimate ${input}.`);
    }

    return estimate;
}

function formatResultTable(prompts) {
    return stripIndent`
        | Person | ${prompts.map(prompt => prompt.person.firstName).join(" | ")} |
        |---|${prompts.map(() => "---").join("|")}|
        | **Estimate** | ${prompts.map(prompt => prompt.value).join(" | ")} |
    `;
}
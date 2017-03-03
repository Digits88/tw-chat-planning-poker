import { EventEmitter } from "events";
import qs from "qs";
import winston from "winston";
import moment from "moment";
import Promise, { CancellationError } from "bluebird";
import { prompt } from "@teamwork/tw-chat/src/util";
import { stripIndent } from "common-tags";
import { without } from "lodash";
import Round from "./Round";

const ICON_ANNOUNCEMENT = ":microphone:";
const ICON_WAITING = ":hourglass_flowing_sand:";
const ICON_ALERT = ":bangbang:";
const ICON_COMPLETE = ":white_check_mark:";
const ICON_CELEBRATE = ":shipit:";
const ICON_QUESTION = ":question:";
const ICON_ERROR = ":x:";
const ICON_HELP = ":sos:";
const ICON_SKIP = ":dash:";
const ICON_MODERATOR = ":wolf:";

export default class Session extends EventEmitter {
    room;
    rounds;
    moderator;

    constructor(admin, room, moderator) {
        super();

        this.admin = admin;
        this.room = room;
        this.moderator = moderator;
        this.rounds = [];
        this.completedRounds = [];
        this.skippedRounds = [];

        winston.info("create new session", { room: room.id, moderator: moderator.id });

        this.mentionCommands = new RegExp(`^@${room.api.user.handle} (help|start|skip|pass|vote|plan|estimate|status|add)(.*)`);
        this.directCommands = new RegExp(`^@${room.api.user.handle} (help|stop)(.*)`);

        // Listen for commands in the room
        this.room.on("message:mention", this.handleMention.bind(this));
        this.room.on("person:added", this.handleAddedPerson.bind(this));
        this.room.on("person:removed", this.handleRemovedPerson.bind(this));

        // Listen for commands from the user
        this.room.people.forEach(person => person.on("message:received", this.handleDirectMessage.bind(person, this)));
    }

    async handleAddedPerson(person) {
        await this.broadcast(`${ICON_ALERT} ${person.firstName} has joined the planning. Hi @${person.handle}!`);
        await person.sendMessage(this.formatDirectWelcomeMessage(person));
    }

    async handleRemovedPerson(person) {
        await this.broadcast(`${ICON_ALERT} ${person.firstName} has left the room.`);
        await person.sendMessage(`${person.firstName}, you have left or have been removed from planning${this.name ? " " + this.name : ""}, I won't annoy you anymore.`);
    }

    async init() {
        await this.room.updateTitle("Sprint Planning Poker");
        await this.help();
        await this.broadcast(
            `To begin, @${this.moderator.handle} (the moderator) must select a tasklist to plan. ` +
            `*Example:* \`@bot plan http://digitalcrew.teamwork.com/#tasklist/124424\``
        );

        await Promise.delay(2000);
        await this.broadcastDirect(person => this.formatDirectWelcomeMessage(person));
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

                    case "vote":
                        if(!args) {
                            throw new Error("Please provide an estimate.");
                        }

                        return this.vote(message.author, parseEstimate(args));
                    break;

                    case "estimate":
                        if(message.author !== this.moderator) {
                            throw new Error(`Sorry @${message.author}, only the moderator can set the estimate.`);
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

        this.planning = true;
        this.startTime = moment();

        while(this.currentRound = this.rounds.shift()) {
            winston.info("moving to the next round");
            let result;

            try {
                result = await this.currentRound.execute();
            } catch(err) {
                // If the moderator manually sets the esimate, we cancel the currently executing round
                if(err instanceof CancellationError) {
                    await this.broadcastDirect(`:no_entry: No need to estimate the last task, we're skipping it for now.`);

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

        this.currentRound = null;
        this.endTime = moment();
        this.duration = moment.duration(this.endTime.diff(this.startTime));
        this.planning = false;
        this.completed = true;

        await this.broadcastAll(`${ICON_CELEBRATE} Sprint planning complete. It only took ${this.duration.humanize()}.`);
        await this.broadcast(this.completedRounds.map((round, i) => `${i}. ${round.formatTaskLink()} - **${round.value}**`).join("\n"));

        this.emit("complete");
    }

    async plan(installation, tasklist) {
        if(this.rounds.length || this.planning) {
            throw new Error("Cannot plan another tasklist when we're already planning!");
        }

        // Get the tasks. Once we get the whole API together in one module, this will be awesome
        this.tasklist = (await this.admin.api.request(`/tasklists/${tasklist}.json`))["todo-list"];
        const tasks = (await this.admin.api.request(`/tasklists/${parseInt(tasklist)}/tasks.json`))["todo-items"];

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
            `${ICON_ANNOUNCEMENT} Okay, we're going to plan the **${this.tasklist.name}** tasklist. ` + 
            `${ICON_WAITING} There are ${tasks.length} tasks to plan. To start, @${this.moderator.handle} ping me to start (\`@${this.admin.handle} start\`).`
        );

        this.name = this.tasklist.name;
        await this.room.updateTitle(`Sprint planning poker: ${this.name}`);
    }

    async estimate(estimate) {
        if(!this.planning) {
            throw new Error("There is no current task to set the estimate for, sorry!");
        }

        this.currentRound.finalize(estimate);

        const hours = Math.floor(estimate);
        const minutes = Math.floor((estimate - hours) * 60);

        await this.admin.api.request("/?action=invoke.tasks.OnSetTaskEstimates()", { // I know about `query`, the API complains >.>
            method: "POST",
            raw: true,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "twProjectsVer": "2.0"
            },
            body: qs.stringify({
                projectId: this.tasklist.projectId,
                taskId: this.currentRound.task.id,
                taskEstimateHours: hours,
                taskEstimateMins: minutes
            })
        });

        await this.broadcast(`${ICON_COMPLETE} Updating task **${this.currentRound.task.title}** with an estimate of **${estimate}** hr(s).`);
    }

    async vote(person, estimate) {
        if(!this.planning) {
            throw new Error("There is not task to vote on!");
        }

        const prompt = this.currentRound.prompts.find(prompt => prompt.person === person);

        if(prompt.isPending()) {
            prompt.finalize(estimate);
        } else {
            throw new Error("Already voted!");
        }
    }

    async nextRound() {
        this.completedRounds.push(this.currentRound);
        const completed = this.completedRounds.length;
        const pending = this.rounds.length;
        const total = completed + pending;
        await this.broadcast(`${ICON_ANNOUNCEMENT} Moving to next task (#${completed} of ${total}, ${pending} to go).`);
    }

    async skip() {
        if(!this.planning) {
            throw new Error(`There is no task to skip!`);
        }

        this.currentRound.cancelAllEstimates();
        this.skippedRounds.push(this.currentRound);
        await this.broadcastAll(`${ICON_SKIP} Skipping task ${this.currentRound.formatTaskLink()}. Removing it from the planning.`);
    }

    async pass() {
        if(!this.planning) {
            throw new Error(`There is no task to pass!`);
        }

        this.currentRound.cancelAllEstimates();
        this.rounds.push(this.currentRound);
        await this.broadcastAll(`${ICON_SKIP} Hold up, we'll complete this task later. Pushing task to end of the queue.`);
    }

    help() {
        const handle = `@${this.admin.handle}`;
        return this.broadcast(stripIndent`
            ${ICON_HELP} **Sprint Poker Planning Help**
            * *"${handle} plan <tasklist url>"* to set the tasklist to plan.
            * *"${handle} start"* to begin the planning.
            * *"${handle} skip"* to skip planning a task.
            * *"${handle} pass"* to push the task to the end of the planning queue.
            * *"${handle} estimate <hours>"* to manually set the estimate (only the moderator, @${this.moderator.handle}, can do this).
            * *"${handle} vote <hours>"* to publically vote your estimate during a round.
            * *"${handle} status"* to get who is still current estimating.
            * *To add or remove user's from the sprint planning, use the people tab.*
        `);
    }

    status() {
        let output = [
            `${ICON_MODERATOR} ${this.moderator.firstName} is the moderator.`,
            `${ICON_COMPLETE} ${this.completedRounds.length} of ${this.rounds.length} tasks estimated.`
        ];

        if(this.planning) {
            const estimating = this.currentRound.getEstimatingUsers();

            output.push(`${ICON_ANNOUNCEMENT} Current task: [${this.currentRound.task.title}](${this.currentRound.task.link})`);

            if(estimating.length) {
                output.push(`${ICON_WAITING} ${estimating.map(p => "@" + p.handle).join(", ")} are still estimating.`);
            } 
        }

        if(this.completed) {
            output.push(`${ICON_CELEBRATE} Sprint planning complete.`);
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

    formatDirectWelcomeMessage(person) {
        return (
            `Hi @${person.handle}, you've been included in Sprint Planning Poker with ` + 
            `${without(this.participants, person).map(person => person.firstName).join(", ")}. I'll be asking ` +
            `you for estimates soon when the planning starts.`
        );
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
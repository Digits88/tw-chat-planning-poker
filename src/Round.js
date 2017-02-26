import Promise, { CancellationError } from "bluebird";
import winston from "winston";
import { stripIndent } from "common-tags";
import { Prompt } from "@teamwork/tw-chat/src/util";
import { zipObject, mapValues, meanBy } from "lodash";
import moment from "moment";

export default class Round {
    constructor(session, task) {
        winston.info("new round", { task });
        this.session = session;
        this.task = task;
        this.prompts = [];
    }

    async execute() {
        winston.info("starting new round");
        this.startTime = moment();

        // Add the task to the session room
        await this.session.broadcast(this.formatTask());

        // Await the estimates
        const estimates = await this.getAllEstimates();

        this.end();

        return {
            startTime: this.startTime,
            endTime: this.endTime,
            duration: moment.duration(this.endTime.diff(this.startTime)),
            estimates: this.prompts,
            average: meanBy(estimates)
        };
    }

    getAllEstimates() {
        this.prompts = this.session.participants.map(participant => {
            return new Prompt(participant, {
                message: `${this.formatTask()}\nPlease input a time estimate (in hours) e.g. 0.5, 1, 4`,
                validate: "float"
            });
        });

        return new Promise((resolve, reject) => {
            this.reject = reject;

            Promise.all(this.prompts.map(prompt => {
                return prompt.run().tap(async result => {
                    // Notify the other when someone has voted
                    await prompt.person.sendMessage(`:white_check_mark: Thank you. You estimate of ${result} hr(s) has be submitted.`);
                    await this.session.broadcast(`:heavy_check_mark: ${prompt.person.firstName} has voted.`);
                });
            })).then(resolve, reject);
        });
    }

    cancelAllEstimates() {
        this.reject(new CancellationError("Estimation cancelled."));
        this.reject = null;
        this.prompts.forEach(prompt => prompt.cancel());
        this.prompts = [];
    }

    getEstimatingUsers() {
        return this.prompts.filter(prompt => prompt.isPending()).map(prompt => prompt.person);
    }

    formatTask() {
        return `---\n:arrow_right: Task #${this.task.id}: ${this.formatTaskLink()}`;
    }

    formatTaskLink() {
        return `[${this.task.title}](${this.task.link})`;
    }

    end() {
        winston.info("round over");
        this.endTime = moment();
    }

    finalize(value) {
        this.value = value;
        this.end();
    }
}
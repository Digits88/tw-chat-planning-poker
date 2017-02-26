# Sprint Poker planning for Teamwork Chat

### How it works
1. The moderator initiates a poker planning session by providing the planner with a link to the tasklist:

    Moderator: @bot poker https://digitalcrew.teamwork.com/index.cfm#tasklists/951053

2. The bot creates a room with the moderator and it's then up to the moderator to add the user's who will participate in the poker by adding the to the room.

    <inside new room>
    Bot: Welcome @moderator to the poker planning room. Add the user's you wish to start the poker planning with.
    Moderator: @jago @emmet @adrian

3. The moderator starts the poker planning session.

    Moderator: @bot start

4. The bot will pick the first task in the list and ask each user individually (i.e. in direct conversations) how much time they think the task will take:

    Bot: Task #122412: Go over tickets related to leaving rooms/noisiness
    Bot: How much time will this take?
    User: 6 hours

5. When all voting is complete for the task, the task moderator in the public room will give the average vote and ask the moderator (in direct conversation) for confirmation:

    Bot: Average vote: 4 hours, awaiting confirmation from moderator
    Bot: 4 hours estimated to task #122412

6. Go onto next task.
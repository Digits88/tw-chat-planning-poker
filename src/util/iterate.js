export default function iterate(condition, callback) {
    return Promise.try(() => {
        if(condition()) {
            return callback().then(whileIterate.bind(condition, callback));
        }
    });
}
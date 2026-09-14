// Importing this package succeeds even when the operation's dependency is missing.
exports.run = () => require("@acceptance/driver").value;

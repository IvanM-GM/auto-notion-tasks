const fs = require("fs");
const path = require("path");
const { Client } = require("@notionhq/client");

// Ініціалізація клієнта Notion
const notion = new Client({
    auth: "YOUR_TOKEN",
});

// Змінні для ID баз даних
const mainDatabaseId = ""; // Сurrent tasks database1
const secondDatabaseId = ""; // Project database2
const thirdDatabaseId = ""; // Targeted projects database3

async function createNewTask(
    title,
    status,
    priority,
    project,
    executionInterval,
    linkToTask,
    taskType,
    cyclic
) {
    const titleProperty = {
        title: [
            {
                text: {
                    content: title,
                },
            },
        ],
    };

    const properties = {
        Tasks: titleProperty,
        Status: status ? { select: { name: status } } : undefined,
        Priority: priority ? { select: { name: priority } } : undefined,
        Project: project ? { select: { name: project } } : undefined,
        ExecutionInterval: executionInterval
            ? { rich_text: [{ text: { content: executionInterval } }] }
            : undefined,
        LinkToTheTask: linkToTask ? { url: linkToTask } : undefined,
        TaskType: taskType ? { select: { name: taskType } } : undefined,
        Cyclic: cyclic ? { select: { name: cyclic } } : undefined,
    };

    await notion.pages.create({
        parent: { database_id: mainDatabaseId },
        properties: properties,
    });
}

async function getCompletedTasks() {
    const response = await notion.databases.query({
        database_id: mainDatabaseId,
        filter: {
            property: "Status",
            select: {
                equals: "Виконано",
            },
        },
    });

    return response.results;
}

function getCurrentDate() {
    return new Date().toISOString();
}

// async function updateTaskWithCompletionDate(taskId, currentDate) {
//     const task = await notion.pages.retrieve({ page_id: taskId });

//     const existingDate = task.properties["DateOfCreation"]?.date?.start;
//     if (!existingDate) {
//         await notion.pages.update({
//             page_id: taskId,
//             properties: {
//                 DateOfCreation: {
//                     date: {
//                         start: currentDate,
//                     },
//                 },
//             },
//         });
//     }
// }
async function updateTaskWithCompletionDate(taskId, currentDate) {
    try {
        // Отримуємо деталі завдання
        const task = await notion.pages.retrieve({ page_id: taskId });

        // Перевіряємо, чи властивість існує та чи має дату
        const existingDate = task.properties["DateOfCreation"]?.date?.start;

        // Якщо властивість відсутня або пуста, додаємо поточну дату
        if (!existingDate) {
            await notion.pages.update({
                page_id: taskId,
                properties: {
                    DateOfCreation: {
                        date: {
                            start: currentDate,
                        },
                    },
                },
            });
            console.log(`Додано дату до завдання ${taskId}: ${currentDate}`);
        } else {
            console.log(`Завдання ${taskId} вже має дату: ${existingDate}`);
        }
    } catch (error) {
        console.error(`Помилка оновлення завдання ${taskId}:`, error.message);
    }
}

async function findIncompleteTaskByTitle(title, project) {
    const response = await notion.databases.query({
        database_id: mainDatabaseId,
        filter: {
            and: [
                { property: "Tasks", title: { equals: title } },
                { property: "Status", select: { equals: "Не виконано" } },
                {
                    property: "Cyclic",
                    select: { does_not_equal: "Одноразове" },
                },
                { property: "Project", select: { equals: project } },
            ],
        },
    });

    return response.results.length > 0;
}

const taskLock = new Set();

async function processFirstScript() {
    const completedTasks = await getCompletedTasks();
    const currentDate = getCurrentDate();

    // Використовуємо `Promise.all` для обробки задач паралельно
    const tasksToUpdate = completedTasks.map(async (task) => {
        const taskId = task.id;
        if (taskLock.has(taskId)) return; // Уникаємо дублювання

        taskLock.add(taskId); // Блокуємо задачу
        try {
            const title =
                task.properties["Tasks"]?.title?.[0]?.text?.content || "";
            const priority = task.properties["Priority"]?.select?.name || null;
            const project = task.properties["Project"]?.select?.name || null;
            const executionInterval =
                task.properties["ExecutionInterval"]?.rich_text?.[0]?.text
                    ?.content || "";
            const linkToTask = task.properties["LinkToTheTask"]?.url || null;
            const taskType = task.properties["TaskType"]?.select?.name || null;
            const cyclic = task.properties["Cyclic"]?.select?.name || null;

            // Оновлюємо задачу з датою завершення
            await updateTaskWithCompletionDate(taskId, currentDate);

            // Перевіряємо, чи існує невиконана задача
            const incompleteTaskExists = await findIncompleteTaskByTitle(
                title,
                project
            );

            // Створюємо задачу, якщо вона ще не існує і задача не "Одноразове"
            if (!incompleteTaskExists && cyclic !== "Одноразове") {
                const taskKey = `${title}-${project}-${cyclic}`;
                if (taskLock.has(taskKey)) return; // Уникаємо дублювання задач

                taskLock.add(taskKey); // Додаємо ключ задачі для блокування
                await createNewTask(
                    title,
                    "Не виконано",
                    priority,
                    project,
                    executionInterval,
                    linkToTask,
                    taskType,
                    cyclic
                );
            }
        } finally {
            taskLock.delete(taskId); // Знімаємо блокування задачі
        }
    });

    await Promise.all(tasksToUpdate);
}

// Функції другого скрипту
async function getDatabaseRecords(databaseId) {
    const pages = [];
    let cursor = undefined;

    do {
        const response = await notion.databases.query({
            database_id: databaseId,
            start_cursor: cursor,
        });

        pages.push(...response.results);
        cursor = response.next_cursor;
    } while (cursor);

    return pages;
}

async function getLatestDatesFromMainDatabase(databaseId) {
    const records = await getDatabaseRecords(databaseId);

    return records.reduce((acc, page) => {
        const project = page.properties.Project?.select?.name;
        const date = page.properties.DateOfCreation?.date?.start;

        if (project && date) {
            const currentDate = new Date(date);

            if (!acc[project] || new Date(acc[project]) < currentDate) {
                acc[project] = date;
            }
        }

        return acc;
    }, {});
}

async function addNewProjectsToSecondDatabase(databaseId, latestDates) {
    const existingRecords = await getDatabaseRecords(databaseId);
    const existingProjects = existingRecords.map(
        (record) => record.properties.ProjectName?.title[0]?.text?.content
    );

    for (const [projectName, lastCreated] of Object.entries(latestDates)) {
        if (!existingProjects.includes(projectName)) {
            await notion.pages.create({
                parent: { database_id: databaseId },
                properties: {
                    ProjectName: {
                        title: [
                            {
                                text: { content: projectName },
                            },
                        ],
                    },
                    LastCreated: {
                        date: { start: lastCreated },
                    },
                    Status: {
                        select: { name: "active" },
                    },
                },
            });
            console.log(`Новий проект "${projectName}" додано до другої бази.`);
        }
    }
}

async function syncSecondDatabaseWithLatestDates(databaseId, latestDates) {
    const records = await getDatabaseRecords(databaseId);

    for (const record of records) {
        const projectName =
            record.properties.ProjectName?.title[0]?.text?.content;
        const lastCreated = record.properties.LastCreated?.date?.start;

        if (
            latestDates[projectName] &&
            latestDates[projectName] !== lastCreated
        ) {
            await notion.pages.update({
                page_id: record.id,
                properties: {
                    LastCreated: {
                        date: { start: latestDates[projectName] },
                    },
                },
            });
            console.log(
                `Оновлено проект "${projectName}" з датою: ${latestDates[projectName]}`
            );
        }
    }
}

// Очищення бази даних шляхом архівації всіх записів
async function clearDatabase(databaseId) {
    const records = await getDatabaseRecords(databaseId);

    for (const record of records) {
        await notion.pages.update({
            page_id: record.id,
            archived: true, // Архівує запис
        });
    }
}

// Додавання трьох найстаріших проектів у третю базу даних
async function addOldestProjectsToThirdDatabase(
    databaseId,
    latestDates,
    secondDatabaseId
) {
    const secondDatabaseRecords = await getDatabaseRecords(secondDatabaseId);

    // Фільтруємо проекти: виключаємо ті, що мають Status зі значенням "stop"
    const filteredProjects = Object.entries(latestDates).filter(
        ([projectName]) => {
            const projectRecord = secondDatabaseRecords.find(
                (record) =>
                    record.properties.ProjectName?.title?.[0]?.text?.content ===
                    projectName
            );
            return projectRecord?.properties.Status?.select?.name !== "stop";
        }
    );

    // Сортуємо проекти за датами у порядку від найстарішого до найновішого
    const sortedProjects = filteredProjects
        .sort(([, dateA], [, dateB]) => new Date(dateA) - new Date(dateB))
        .slice(0, 3);

    // Очищаємо третю базу даних
    await clearDatabase(databaseId);

    // Додаємо три найстаріші проекти до третьої бази даних
    for (const [projectName] of sortedProjects) {
        await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
                ProjectName: {
                    title: [
                        {
                            text: { content: projectName },
                        },
                    ],
                },
            },
        });
        console.log(`Проект "${projectName}" додано до третьої бази даних.`);
    }

    if (sortedProjects.length < 3) {
        console.log(
            `Не вдалося додати три проекти. Додано лише ${sortedProjects.length}.`
        );
    }
}

// Синхронізація проектів між базами даних
async function syncAndProcessProjects(
    mainDatabaseId,
    secondDatabaseId,
    thirdDatabaseId
) {
    if (!mainDatabaseId || !secondDatabaseId || !thirdDatabaseId) {
        throw new Error("Ідентифікатори баз даних не визначені!");
    }

    const latestDates = await getLatestDatesFromMainDatabase(mainDatabaseId);

    await addNewProjectsToSecondDatabase(secondDatabaseId, latestDates);
    await syncSecondDatabaseWithLatestDates(secondDatabaseId, latestDates);

    await addOldestProjectsToThirdDatabase(
        thirdDatabaseId,
        latestDates,
        secondDatabaseId
    );
}

// Основна функція для злитого процесу
(async function main() {
    console.log("Запуск першого скрипту...");
    await processFirstScript();

    console.log("Перший скрипт завершено. Запуск другого скрипту...");

    if (!mainDatabaseId || !secondDatabaseId || !thirdDatabaseId) {
        console.error("Ідентифікатори баз даних не визначені!");
        return;
    }

    await syncAndProcessProjects(
        mainDatabaseId,
        secondDatabaseId,
        thirdDatabaseId
    );

    console.log("Скрипти успішно виконано.");
})();
